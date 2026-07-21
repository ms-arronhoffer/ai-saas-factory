// Typed API client for the backend. Generated types should replace these once
// the OpenAPI contract is finalised (see contracts/ and ARCHITECTURE.md).
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface Item {
  id: number;
  title: string;
  description: string;
  owner_id: number;
  created_at: string;
}

export async function login(email: string, password: string): Promise<string> {
  const body = new URLSearchParams({ username: email, password });
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("Login failed");
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export async function listItems(token: string): Promise<Item[]> {
  const res = await fetch(`${API_URL}/api/items`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to load items");
  return (await res.json()) as Item[];
}

export async function createItem(token: string, title: string, description: string): Promise<Item> {
  const res = await fetch(`${API_URL}/api/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title, description }),
  });
  if (!res.ok) throw new Error("Failed to create item");
  return (await res.json()) as Item;
}
