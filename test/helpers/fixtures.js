/**
 * Test fixtures — reusable test data.
 */
import bcrypt from 'bcrypt';

// Pre-hashed passwords (bcrypt hash of 'password123')
export const TEST_PASSWORD = 'password123';
export const TEST_PASSWORD_HASH = bcrypt.hashSync('password123', 10);

export const testUsers = {
  admin: {
    username: 'admin',
    password: TEST_PASSWORD,
    passwordHash: TEST_PASSWORD_HASH,
    email: 'admin@test.com',
    role: 'admin'
  },
  user1: {
    username: 'user1',
    password: TEST_PASSWORD,
    passwordHash: TEST_PASSWORD_HASH,
    email: 'user1@test.com',
    role: 'user'
  },
  user2: {
    username: 'user2',
    password: TEST_PASSWORD,
    passwordHash: TEST_PASSWORD_HASH,
    email: 'user2@test.com',
    role: 'user'
  }
};

export const testConversation = {
  id: 'conv_test_001',
  agentId: 'agent_test_001',
  agentName: 'test-agent',
  workDir: '/tmp/test-work',
  claudeSessionId: 'claude_session_001'
};

export const testMessages = {
  userMessage: {
    type: 'user',
    message: { role: 'user', content: 'Hello Claude' }
  },
  assistantMessage: {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello! How can I help?' }]
    }
  },
  toolUseMessage: {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        name: 'Read',
        input: { file_path: '/tmp/test.js' }
      }]
    }
  },
  resultMessage: {
    type: 'result',
    result: 'Task completed successfully'
  }
};
