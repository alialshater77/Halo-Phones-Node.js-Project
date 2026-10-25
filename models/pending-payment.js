const mongoose = require('mongoose');

const Schema = mongoose.Schema;

const pendingPaymentSchema = new Schema({
  paymentIntentId: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  email: {
    type: String,
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  cartHash: {
    type: String,
    required: true
  },
  products: [
    {
      product: { type: Object, required: true },
      quantity: { type: Number, required: true }
    }
  ]
});

module.exports = mongoose.model('PendingPayment', pendingPaymentSchema);
