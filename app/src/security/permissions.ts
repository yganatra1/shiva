export const SHIVA_PERMISSIONS = [
  "web.read",
  "expenses.read",
  "expenses.write",
] as const;

export type ShivaPermission = (typeof SHIVA_PERMISSIONS)[number];

export type PermissionMode = "auto" | "confirm" | "deny";

export const DEFAULT_PERMISSION_MODES: Readonly<
  Record<ShivaPermission, PermissionMode>
> = {
  "web.read": "auto",
  "expenses.read": "auto",
  "expenses.write": "auto",
};

export function isShivaPermission(value: string): value is ShivaPermission {
  return (SHIVA_PERMISSIONS as readonly string[]).includes(value);
}
