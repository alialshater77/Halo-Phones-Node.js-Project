(function () {
  var form = document.getElementById('payment-form');
  if (!form || !window.Stripe) {
    return;
  }

  var stripe = Stripe(form.getAttribute('data-key'));
  var elements = stripe.elements({
    clientSecret: form.getAttribute('data-secret')
  });
  var paymentElement = elements.create('payment');
  paymentElement.mount('#payment-element');

  var errors = document.getElementById('card-errors');
  var button = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (button.disabled) {
      return;
    }
    button.disabled = true;
    stripe
      .confirmPayment({
        elements: elements,
        confirmParams: {
          return_url: form.getAttribute('data-return-url')
        }
      })
      .then(function (result) {
        if (result.error) {
          errors.textContent = result.error.message;
          button.disabled = false;
        }
      });
  });
})();
