export function login(res: any, token: string) {
  res.cookie("session", token, { secure: true, sameSite: "lax" });
}
