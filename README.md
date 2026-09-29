# RK Warehouse

Warehouse management system for RK Box. Module 1: Warehouses & zones.

## Environment variables (Render → Environment)
- `DATABASE_URL`: PostgreSQL connection string (use the Internal Database URL on Render)
- `APP_USERS`: logins, comma-separated `name:password`, e.g. `sahil:StrongPass1,ramesh:Pass2`

## Location addressing
Warehouse code + zone code = the address printed on labels, e.g. `WH01-Z03`.
Later modules extend this to racks and bins: `WH01-Z03-R02-B04`.

## Rules
- Nothing is deleted. Warehouses and zones are archived and can be restored.
- Every change is recorded (who, when, before, after) in the audit log.
- If two people edit the same record, the second save is rejected instead of overwriting.
