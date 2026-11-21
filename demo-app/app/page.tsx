"use client";

import { useState } from "react";

export default function Home() {
  const [username, setUsername] = useState("alice");
  const [password, setPassword] = useState("alice123");
  const [message, setMessage] = useState("");
  const [orders, setOrders] = useState<unknown>(null);
  const [error, setError] = useState("");

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      setError(`login failed: ${res.status}`);
      return;
    }
    setMessage(`logged in as ${username}`);
  }

  async function loadMyOrders() {
    setError("");
    const res = await fetch("/api/orders");
    if (!res.ok) {
      setError(`orders failed: ${res.status}`);
      return;
    }
    setOrders(await res.json());
  }

  async function tryBobsOrder() {
    setError("");
    // The attack Vigil proves: logged in as alice, read bob's order by id.
    const res = await fetch("/api/orders/ord_b1");
    setOrders({ attack: "/api/orders/ord_b1", status: res.status, body: await res.json() });
  }

  return (
    <main>
      <h1>Vigil demo shop</h1>
      <p className="hint">
        Demo users: alice / alice123, bob / bob123. Try the attack button while logged in as
        alice — it requests bob&apos;s order <code>ord_b1</code>.
      </p>
      <form onSubmit={login}>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
        />
        <button type="submit">Log in</button>
      </form>
      <p>
        <button onClick={loadMyOrders}>My orders</button>{" "}
        <button onClick={tryBobsOrder}>Attack: read ord_b1 as alice</button>
      </p>
      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}
      {orders && <pre>{JSON.stringify(orders, null, 2)}</pre>}
    </main>
  );
}
