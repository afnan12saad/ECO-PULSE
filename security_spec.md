# ECO-PULSE Firestore Security Specification

## 1. Data Invariants
1. **Strict Ownership**: A user (`request.auth.uid`) may only read, create, update, or delete documents under `/users/{uid}` and its subcollections when `uid == request.auth.uid` and `request.auth.token.email_verified == true`.
2. **PII Isolation**: Private fields (`email`, private daily logs, notes, goals) live exclusively inside `/users/{uid}` and its subcollections. The `/league/{uid}` collection stores only `displayAlias`, `ecoScore`, `improvementPct`, `totalXP`, `missionsCompleted`, `currentStreak`, `cohort`, `optedIn`, and `updatedAt`.
3. **Immutable Identity & Creation Timestamps**: `uid` and `createdAt` cannot be modified after document creation, and `createdAt`/`updatedAt` must equal `request.time`.
4. **No Shadow Fields**: Every collection enforces exact `keys().hasAll(...)` and `keys().hasOnly(...)` schema checks on create, and strict `affectedKeys().hasOnly(...)` gates on update.
5. **Path ID Hardening**: All document IDs (`uid`, `date`, `missionId`, `goalId`, `notifId`) are validated with `isValidId()` (`^[a-zA-Z0-9_\-]+$`, max 128 chars), and daily log IDs match `^\d{4}-\d{2}-\d{2}$`.
6. **Terminal State Protection**: Completed simulator goals (`status == 'completed'`) cannot be mutated back to `'active'` or altered.

## 2. Adversarial Payloads ("Dirty Dozen")
1. Unauthenticated read of `/users/alice` -> `PERMISSION_DENIED`.
2. Unverified email user writing `/users/alice/dailyLogs/2026-11-18` -> `PERMISSION_DENIED`.
3. Cross-tenant read/write by Bob on `/users/alice` or `/users/alice/dailyLogs/2026-11-18` -> `PERMISSION_DENIED`.
4. Shadow field injection (`isAdmin: true` or `extraField: 1`) on `/users/alice` create -> `PERMISSION_DENIED`.
5. Forged `uid` (`uid: "alice"`) inside `/users/bob` payload -> `PERMISSION_DENIED`.
6. Client-backdated `createdAt` or `updatedAt` (`createdAt != request.time`) -> `PERMISSION_DENIED`.
7. Oversized `displayName` (> 80 chars) or `notes` (> 500 chars) -> `PERMISSION_DENIED`.
8. Invalid `date` document ID (`../bad` or `1.5KB junk`) on `/users/alice/dailyLogs/{date}` -> `PERMISSION_DENIED`.
9. Negative `totalEmissions` (`-5`) or `totalXP` (`-100`) -> `PERMISSION_DENIED`.
10. Reopening a completed goal (`existing().status == 'completed'` -> `status: 'active'`) -> `PERMISSION_DENIED`.
11. Reading a non-opted-in `/league/{otherUid}` entry (`optedIn == false`) -> `PERMISSION_DENIED`.
12. Writing another user's `/league/{aliceUid}` score as Bob -> `PERMISSION_DENIED`.
