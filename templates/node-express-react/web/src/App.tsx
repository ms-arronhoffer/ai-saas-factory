import { useState } from "react";
import { createItem, listItems, login, type Item } from "./api";

// Reference vertical slice: login, then list/create items. Keep the
// loading/empty/error states as you extend this into the product UI.
export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("u@example.com");
  const [password, setPassword] = useState("password123");
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    setError(null);
    setLoading(true);
    try {
      const t = await login(email, password);
      setToken(t);
      setItems(await listItems(t));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!token || !title.trim()) return;
    try {
      await createItem(token, title.trim());
      setItems(await listItems(token));
      setTitle("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "40px auto", padding: 16 }}>
      <h1>SaaS Factory Starter</h1>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {!token ? (
        <div style={{ display: "grid", gap: 8, maxWidth: 320 }}>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" aria-label="email" />
          <input value={password} type="password" onChange={(e) => setPassword(e.target.value)} placeholder="password" aria-label="password" />
          <button onClick={handleLogin} disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New item title" aria-label="new item" />
            <button onClick={handleCreate}>Add</button>
          </div>
          {items.length === 0 ? <p>No items yet — add your first one above.</p> : <ul>{items.map((it) => <li key={it.id}>{it.title}</li>)}</ul>}
        </div>
      )}
    </main>
  );
}
