import nodemailer from 'nodemailer';
import { CONFIG } from './config.js';

let transporter = null;

/**
 * Get or create email transporter
 * @returns {nodemailer.Transporter}
 */
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: CONFIG.smtp.host,
      port: CONFIG.smtp.port,
      secure: CONFIG.smtp.secure,
      auth: {
        user: CONFIG.smtp.user,
        pass: CONFIG.smtp.pass
      }
    });
  }
  return transporter;
}

/**
 * Send verification code email
 * @param {string} to - Recipient email address
 * @param {string} code - Verification code
 * @param {string} username - Username for personalization
 * @returns {Promise<void>}
 */
export async function sendVerificationCode(to, code, username) {
  const transport = getTransporter();

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .code { font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2563eb; padding: 20px; background: #f0f9ff; border-radius: 8px; text-align: center; margin: 20px 0; }
        .footer { color: #6b7280; font-size: 12px; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>WebChat Login Verification</h2>
        <p>Hello ${username},</p>
        <p>Your verification code is:</p>
        <div class="code">${code}</div>
        <p>This code will expire in 5 minutes.</p>
        <p>If you did not request this code, please ignore this email.</p>
        <div class="footer">
          <p>This email was sent by WebChat. Do not reply to this email.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const textContent = `
WebChat Login Verification

Hello ${username},

Your verification code is: ${code}

This code will expire in 5 minutes.

If you did not request this code, please ignore this email.
  `.trim();

  await transport.sendMail({
    from: CONFIG.smtp.from,
    to,
    subject: `WebChat Verification Code: ${code}`,
    text: textContent,
    html: htmlContent
  });
}

/**
 * Test email configuration
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function testEmailConfig() {
  try {
    const transport = getTransporter();
    await transport.verify();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
