import jwt from "jsonwebtoken";

export function accept(token: string, key: string) {
  return jwt.verify(token, key, { algorithms: ["none", "HS256"] });
}
