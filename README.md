
# Inventory MVP (Frames) — Express + SQLite

**What it does**
- Item Types → Items (SKU) → Batches → Stock Movements (IN/OUT/ADJUST)
- Products (e.g., **Frame**) with multi-level **BOM**
- Work Orders: consume components per BOM and record OUT movements
- Unique codes (SKU, Batch, Product, WorkOrder) via `nanoid`
- Timestamps, cost tracking (moving average per Item based on received batches)

**Quick Start**
```bash
cd inventory-mvp
npm install
npm run start
# open http://localhost:3000
```
The first run creates `inventory.db` with schema + a few demo records.

**Tech stack**
- Node.js + Express
- SQLite (synchronous driver: better-sqlite3 — simple & fast)
- Vanilla HTML/JS frontend (`/public`)

**Notes**
- Costs: moving average per item. Each `receive` updates avg_cost.
- Work Order `complete` will:
  - Calculate total required per BOM (BOM.qty_per * workorder.quantity)
  - Create OUT stock movements for components
- Finished Goods: optionally tracked as a normal `Item` of type `FG`. (Demo seeds include a `Frame-A` product and an `FG-Frame` item.)

---

© 2025-09-22
