---
name: RBAC permission model
description: Server-side role normalization and permission boundaries for Biz-transPay staff access.
---

Staff accounts retain the legacy `role=admin|super_admin` storage shape, while `admin_role` maps to the effective roles SUPPORT, FINANCE, COMPLIANCE, or ADMIN. SUPER_ADMIN bypasses the permission matrix. User and merchant accounts map to USER and MERCHANT.

**Why:** Existing admin records need backward compatibility, but route authorization must distinguish support, finance, compliance, operations, and platform ownership instead of treating every authenticated administrator as equivalent.

**How to apply:** Keep the permission matrix server-side, derive the effective role from the stored account fields, authorize admin routes before loading or mutating data, and expose only the effective role plus permission names to the frontend for navigation. Frontend visibility is convenience only; the server remains authoritative.