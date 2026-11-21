import jwt from "jsonwebtoken";

export function userFrom(token: string, key: string) {
  const payload = jwt.verify(token, key, { algorithms: ["HS256"] }) as { sub: string };
  return jwt.decode(token) && payload.sub;
}
