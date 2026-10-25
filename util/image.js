const fs = require('fs');
const path = require('path');

let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  sharp = null;
}

function resizeUpload(filePath) {
  if (!sharp || !filePath) {
    return Promise.resolve();
  }
  let input;
  try {
    input = fs.readFileSync(filePath);
  } catch (err) {
    console.log(err);
    return Promise.resolve();
  }
  return sharp(input)
    .rotate()
    .resize({ width: 1200, withoutEnlargement: true })
    .toBuffer()
    .then(buffer => {
      fs.writeFileSync(filePath, buffer);
    })
    .catch(err => {
      console.log(err);
    });
}

module.exports = {
  resizeUpload: resizeUpload,
  imagesDir: path.join(__dirname, '..', 'images')
};
