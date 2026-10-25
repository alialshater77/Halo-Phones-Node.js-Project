(function () {
  var input = document.getElementById('image');
  var preview = document.getElementById('image-preview');
  if (!input || !preview) {
    return;
  }

  input.addEventListener('change', function () {
    var file = input.files && input.files[0];
    if (!file) {
      if (preview.dataset.current) {
        preview.src = preview.dataset.current;
        preview.classList.remove('image-picker__preview--empty');
      } else {
        preview.removeAttribute('src');
        preview.classList.add('image-picker__preview--empty');
      }
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      preview.src = reader.result;
      preview.classList.remove('image-picker__preview--empty');
    };
    reader.readAsDataURL(file);
  });
})();
