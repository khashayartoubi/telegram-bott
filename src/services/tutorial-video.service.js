const fs = require('fs');
const path = require('path');

const VIDEO_DIRECTORY = path.resolve(__dirname, '../../video');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm']);

function getTutorialVideoPath() {
  if (!fs.existsSync(VIDEO_DIRECTORY)) return null;

  const video = fs.readdirSync(VIDEO_DIRECTORY).find((file) =>
    VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase()),
  );

  return video ? path.join(VIDEO_DIRECTORY, video) : null;
}

module.exports = { getTutorialVideoPath };
