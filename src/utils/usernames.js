const crypto = require('crypto');

function createUsername() {
  // کوتاه، رشته‌ای و مناسب محدودیت نام کاربری 3x-ui
  return `vpn_${crypto.randomBytes(5).toString('hex')}`;
}

function isValidUsername(username) {
  return /^[a-zA-Z0-9_-]{3,32}$/.test(username);
}

module.exports = { createUsername, isValidUsername };
