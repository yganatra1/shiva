export const SHIVA_PERMISSIONS = [
  "web.read",
  "expenses.read",
  "expenses.write",
  "workspace.read",
] as const;

export type ShivaPermission = (typeof SHIVA_PERMISSIONS)[number];

export type PermissionMode = "auto" | "confirm" | "deny";

export const DEFAULT_PERMISSION_MODES: Readonly<
  Record<ShivaPermission, PermissionMode>
> = {
  "web.read": "auto",
  "expenses.read": "auto",
  "expenses.write": "auto",
  "workspace.read": "auto",
};

export function isShivaPermission(value: string): value is ShivaPermission {
  return (SHIVA_PERMISSIONS as readonly string[]).includes(value);
}
