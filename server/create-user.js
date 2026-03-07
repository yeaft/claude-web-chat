#!/usr/bin/env node
/**
 * Create an admin user directly in the SQLite database
 * Usage: node create-user.js <username> <password> [email] [role]
 * Example: node create-user.js admin mypassword admin@example.com
 * Example: node create-user.js admin mypassword admin@example.com pro
 */

import bcrypt from 'bcrypt';
import { userDb } from './database.js';

async function main() {
  const [,, username, password, email, role] = process.argv;

  if (!username || !password) {
    console.log('Usage: node server/create-user.js <username> <password> [email] [role]');
    console.log('');
    console.log('Arguments:');
    console.log('  username    Username for login');
    console.log('  password    Password (will be bcrypt hashed)');
    console.log('  email       Email address (optional, default: username@local)');
    console.log('  role        User role: admin, pro, user (optional, default: admin)');
    console.log('');
    console.log('Examples:');
    console.log('  node server/create-user.js admin mypassword admin@example.com');
    console.log('  node server/create-user.js viewer pass123 viewer@example.com user');
    process.exit(1);
  }

  const userEmail = email || `${username}@local`;
  const userRole = role || 'admin';

  if (!['admin', 'pro', 'user'].includes(userRole)) {
    console.error(`Invalid role: ${userRole}. Must be one of: admin, pro, user`);
    process.exit(1);
  }

  // Generate password hash
  const passwordHash = await bcrypt.hash(password, 10);

  // Write directly to SQLite database
  const result = userDb.migrateUser(username, passwordHash, userEmail, userRole);

  if (result) {
    console.log(`User "${username}" created successfully.`);
    console.log(`  Role: ${userRole}`);
    console.log(`  Email: ${userEmail}`);
    if (result.agent_secret) {
      console.log(`  Agent Secret: ${result.agent_secret}`);
    }
    console.log('\nTOTP will be set up on first login if TOTP_ENABLED=true.');
  } else {
    console.error('Failed to create user.');
    process.exit(1);
  }
}

main().catch(console.error);
