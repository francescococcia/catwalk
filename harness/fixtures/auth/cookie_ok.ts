export function login(res: any, token: string) {
  res.cookie("session", token, { httpOnly: true, secure: true, sameSite: "lax" });
}
