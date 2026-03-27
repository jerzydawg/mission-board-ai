const sharedEnv = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://mwsvekxgkjlmbglargmg.supabase.co",
  SUPABASE_SERVICE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13c3Zla3hna2psbWJnbGFyZ21nIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzkxOTE3MiwiZXhwIjoyMDg5NDk1MTcyfQ._2NymYGbZDJYmyyyjrZ0niD7VaqCULhjZho1aeU3EtQ",
  JWT_SECRET: "mrdelegate-jwt-secret-2026",
  CUSTOMER_JWT_SECRET: "mrdelegate-customer-jwt-secret-2026",
  RESEND_API_KEY: "re_aycNVj68_2TavCMdR2Lpv9FoXNZLjdgtW",
  STRIPE_SECRET_KEY: "sk_test_placeholder",
  ADMIN_EMAIL: "bart@impulsive-marketing.com",
  ADMIN_PASSWORD_HASH: "$2b$10$NHABpGAyeTZ6vCJvb/ZMzOxbYranD/FjzksSHHCuOgRTZEivVVx3.",
  TOKEN_ENCRYPTION_KEY: "mrdelegate-token-encryption-key-2026",
  OPENCLAW_URL: "http://127.0.0.1:18789",
  OPENCLAW_TOKEN: "P0bLOExLU30tRossxTrZjYELqWd3EZLm"
};

module.exports = {
  apps: [
    {
      name: "mission-board",
      script: "./src/server.js",
      cwd: "/home/openclaw/.openclaw/mission-board-local",
      env: { ...sharedEnv, PORT: "3007" }
    },
    {
      name: "mission-intelligence",
      script: "./src/workers/intelligence-engine.js",
      cwd: "/home/openclaw/.openclaw/mission-board-local",
      env: sharedEnv
    },
    {
      name: "mission-dispatcher",
      script: "./src/workers/task-dispatcher.js",
      cwd: "/home/openclaw/.openclaw/mission-board-local",
      env: sharedEnv
    }
  ]
};
