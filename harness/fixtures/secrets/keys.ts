// FAKE values for vigil tests. AKIAIOSFODNN7EXAMPLE is the documented AWS example key id.
export const awsKeyId = process.env.AWS_KEY_ID ?? "AKIAIOSFODNN7EXAMPLE";
export const pem = `
-----BEGIN RSA PRIVATE KEY-----
FAKE
-----END RSA PRIVATE KEY-----`;
