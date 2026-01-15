require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const nodemailer = require('nodemailer'); 

// Models
const User = require('./models/User');
const Goal = require('./models/Goal');

const app = express();
app.use(express.json());
app.use(cors());

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error(err));

// AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- BREVO SMTP SETUP ---
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com", 
  port: 587,
  secure: false, 
  auth: {
    user: "a0004d001@smtp-brevo.com", // Hardcoded to ensure accuracy
    pass: process.env.EMAIL_PASS,     // Keep using the Env Variable for security
  },
});

const otpStore = {};

// Middleware
const authMiddleware = (req, res, next) => {
  const token = req.header('Authorization');
  if (!token) return res.status(401).json({ error: 'Access denied' });
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ error: 'Invalid Token' });
  }
};

// --- ROUTES ---

// 1. Register
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    const user = new User({ name, email, password: hashedPassword });
    await user.save();
    res.json({ message: 'User registered' });
  } catch (err) {
    res.status(400).json({ error: 'Email already exists' });
  }
});

// 2. Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(400).json({ error: 'User not found' });

  const validPass = await bcrypt.compare(password, user.password);
  if (!validPass) return res.status(400).json({ error: 'Invalid password' });

  const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET);
  res.json({ token, name: user.name });
});

// 3. Forgot Password
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[email] = { otp, expires: Date.now() + 10 * 60 * 1000 };

  // --- FIX: HARDCODED SENDER ---
  // This matches exactly what is verified in your Brevo screenshot
  const mailOptions = {
    from: "sselvaganesh765@gmail.com", 
    to: email,
    subject: 'Password Reset OTP - Goal Planner',
    text: `Your OTP for password reset is: ${otp}. It expires in 10 minutes.`,
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ message: 'OTP sent to your email' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// 4. Reset Password
app.post('/api/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const storedOtpData = otpStore[email];

  if (!storedOtpData) return res.status(400).json({ error: 'Invalid or expired OTP request' });
  if (storedOtpData.expires < Date.now()) {
    delete otpStore[email];
    return res.status(400).json({ error: 'OTP has expired' });
  }
  if (storedOtpData.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await User.findOneAndUpdate({ email }, { password: hashedPassword });
  delete otpStore[email];

  res.json({ message: 'Password reset successfully' });
});

// 5. Create Goal
app.post('/api/goals', authMiddleware, async (req, res) => {
  const { title, description, deadline, hoursPerDay } = req.body;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" }); 
    const today = new Date().toDateString();

    const prompt = `
      Today's date is: ${today}.
      I have a goal: "${title}". Description: "${description}".
      I have ${hoursPerDay} hours per day available. The requested deadline is ${deadline}.
      Generate a day-by-day roadmap starting from tomorrow.
      
      Strictly return ONLY a JSON object in this format (no markdown, no code fences):
      {
        "adjustmentMessage": "Explanation or null",
        "roadmap": [
          { "day": 1, "task": "Task description" }
        ]
      }
    `;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    const jsonStr = text.replace(/```json|```/g, '').trim(); 
    const parsedResponse = JSON.parse(jsonStr);

    const goal = new Goal({
      userId: req.user._id,
      title,
      description,
      deadline,
      hoursPerDay,
      adjustmentMessage: parsedResponse.adjustmentMessage || null, 
      roadmap: parsedResponse.roadmap || []
    });

    await goal.save();
    res.json(goal);

  } catch (error) {
    console.error("AI Error:", error);
    res.status(500).json({ error: 'AI generation failed' });
  }
});

// 6. Get User Goals
app.get('/api/goals', authMiddleware, async (req, res) => {
  try {
    const goals = await Goal.find({ userId: req.user._id });
    res.json(goals);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch goals' });
  }
});

// 7. Update Task Status
app.put('/api/goals/:goalId/task/:taskId', authMiddleware, async (req, res) => {
  try {
    const { goalId, taskId } = req.params;
    const goal = await Goal.findById(goalId);
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    const task = goal.roadmap.id(taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    task.completed = !task.completed; 
    await goal.save();
    res.json(goal);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// 8. DELETE GOAL
app.delete('/api/goals/:id', authMiddleware, async (req, res) => {
  try {
    const goalId = req.params.id;
    const deletedGoal = await Goal.findOneAndDelete({ _id: goalId, userId: req.user._id });
    if (!deletedGoal) return res.status(404).json({ error: 'Goal not found' });
    res.json({ message: 'Goal deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error while deleting goal' });
  }
});

// 9. UPDATE ENTIRE GOAL
app.put('/api/goals/:id', authMiddleware, async (req, res) => {
  try {
    const goalId = req.params.id;
    const updates = req.body;
    const updatedGoal = await Goal.findOneAndUpdate(
      { _id: goalId, userId: req.user._id },
      { $set: updates },
      { new: true }
    );
    if (!updatedGoal) return res.status(404).json({ error: 'Goal not found' });
    res.json(updatedGoal);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update goal' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));