const mongoose = require('mongoose');

const GoalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: String,
  deadline: Date,
  hoursPerDay: Number,

  // --- NEW FIELD: Stores the AI's explanation for date changes ---
  adjustmentMessage: { type: String, default: null }, 

  roadmap: [
    {
      day: Number,
      task: String,
      completed: { type: Boolean, default: false }
    }
  ],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Goal', GoalSchema);