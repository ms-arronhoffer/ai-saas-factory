const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export interface Item {
  id: number;
  title: string;
  description: string;
  ownerId: number;
  createdAt: string;
}

export async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error("Login failed");
  return (await res.json()).access_token as string;
}

export async function listItems(token: string): Promise<Item[]> {
  const res = await fetch(`${API_URL}/api/items`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("Failed to load items");
  return (await res.json()) as Item[];
}

export async function createItem(token: string, title: string): Promise<Item> {
  const res = await fetch(`${API_URL}/api/items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error("Failed to create item");
  return (await res.json()) as Item;
}
