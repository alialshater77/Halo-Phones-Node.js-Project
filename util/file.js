const fs = require('fs');
const path = require('path');

const deleteFile = (filePath) => {
    const fullPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(__dirname, '..', filePath);
    fs.unlink(fullPath, err => {
        if (!err || err.code !== 'EBUSY') {
            if (err) {
                console.log(err);
            }
            return;
        }
        setTimeout(() => {
            fs.unlink(fullPath, retryErr => {
                if (retryErr) {
                    console.log(retryErr);
                }
            });
        }, 400);
    });
}

exports.deleteFile = deleteFile;