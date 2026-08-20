import {
  DEFAULT_PERMISSION_MODES,
  isShivaPermission,
  type PermissionMode,
  type ShivaPermission,
} from "./permissions.js";

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly permission: string;
  readonly reason: "auto" | "confirmation_required" | "denied" | "unknown";
}

export class PermissionPolicyEngine {
  private readonly modes: Readonly<Record<ShivaPermission, PermissionMode>>;

  constructor(
    overrides: Partial<Record<ShivaPermission, PermissionMode>> = {},
  ) {
    this.modes = { ...DEFAULT_PERMISSION_MODES, ...overrides };
  }

  evaluate(permission: string): PermissionDecision {
    if (!isShivaPermission(permission)) {
      return { allowed: false, permission, reason: "unknown" };
    }

    const mode = this.modes[permission];
    switch (mode) {
      case "auto":
        return { allowed: true, permission, reason: "auto" };
      case "confirm":
        // Confirmation UX is deliberately not invented in this phase.
        return {
          allowed: false,
          permission,
          reason: "confirmation_required",
        };
      case "deny":
        return { allowed: false, permission, reason: "denied" };
    }
  }

  evaluateAll(permissions: readonly string[]): PermissionDecision {
    for (const permission of permissions) {
      const decision = this.evaluate(permission);
      if (!decision.allowed) {
        return decision;
      }
    }

    return { allowed: true, permission: "", reason: "auto" };
  }
}
