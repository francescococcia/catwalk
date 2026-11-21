import jwt from "jsonwebtoken";

// trusts the payload without checking the signature
export function userFrom(token: string) {
  const payload = jwt.decode(token) as { sub: string };
  return payload.sub;
}
