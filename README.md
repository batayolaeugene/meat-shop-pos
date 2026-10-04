# Karnehan POS 🥩
### Mobile-First, Offline-First Meat Shop POS & Customer Credit (Utang) Ledger

Built with Tailwind CSS v4 and vanilla JavaScript. All data is persisted locally in `localStorage` without requiring any backend server or internet connection.

---

## 🌟 Key Features

### 1. Batch Management (4 Weekly Batches per Month)
- Every month is divided into 4 weekly batches:
  - **Batch 1**: Days 1–7
  - **Batch 2**: Days 8–14
  - **Batch 3**: Days 15–21
  - **Batch 4**: Days 22 to end of month
- **Period Switcher**: Navigate months (previous/next) and switch between Batch 1–4 with real-time badges indicating unpaid debts.
- **"All Active Debts" View**: Instant overview of every unpaid transaction across all past and current batches grouped chronologically.
- **Summary Metrics Cards**:
  - **Total Sales (Gross)**: Total sales volume and kilograms sold.
  - **Cash Collected**: Drawer cash collected (downpayments + collections).
  - **Outstanding Credit (Receivables)**: Unpaid balance remaining for the active batch and grand total receivables.

### 2. Multi-Batch Customer Credit Rollover & FIFO Ledger
- **Automatic Rollover**: When a customer purchases on credit in Batch 2 while still having an unpaid balance from Batch 1, their balance automatically accumulates.
- **Visual Rollover Callout**: When recording a sale for an existing customer with debt, the form displays a live rollover breakdown (`Previous balance + Unpaid from this sale = New total debt`).
- **Two Main Views**:
  - **Sales Register**: Batch-specific sales transactions, filterable by status (*All*, *Unpaid*, *With Balance*, *Fully Paid*) and searchable by customer or cut name.
  - **Customer Ledgers**: Customer-centric view showing overall accumulated debt across all batches, sortable by highest debt, recent activity, or alphabetical name.
- **Statement of Account**: Full chronological ledger with running balances, break down by batch, and one-tap **Share** button (native Web Share or clipboard copy formatted for Messenger / SMS).

### 3. Add Transaction Form
- **Customer Selection**: Choose from existing customers (with auto-complete and quick-pick chips) or type a new name to create a profile automatically.
- **Meat Cuts**:
  - Liempo (₱380/kg default)
  - Kasim (₱320/kg default)
  - Pigue (₱330/kg default)
  - Ribs / Costillas (₱360/kg default)
  - Pata (₱280/kg default)
  - Ulo / Maskara (₱200/kg default)
  - Ginabot / Innards (₱180/kg default)
  - Custom Cut (with custom name and pricing)
  - Dynamic price memory (remembers custom per-kg prices entered by the butcher).
- **Weight Quick-Picks**: ¼ kg, ½ kg, 1 kg, 1½ kg, 2 kg, 5 kg, or custom decimal.
- **Auto-Calculated Total (₱)**: Exact centavo-precision calculation with no floating-point rounding errors.
- **Payment Modes**:
  - **Cash (Full)**: Auto-computes change when cash tendered is provided.
  - **Full Credit (₱0 down)**: Full amount added to customer debt.
  - **Credit with Downpayment / Partial**: Enter cash received; instantly computes remaining item balance and accumulated customer utang.
- **"Save & Add Cut"**: Quick multi-cut entry for bulk buyers without reopening the dialog.

### 4. Dynamic Status Badges
- 🟢 **Fully Paid**: Remaining balance = ₱0.00.
- 🟡 **With Balance**: Partial payment or downpayment was made.
- 🔴 **Unpaid**: ₱0.00 was paid at purchase.

### 5. Quick Payment Collector (FIFO Allocation)
- Accessible from both the **Sales Register** cards, the **Customer Ledger** list, and the **Customer Detail / Statement** screen.
- Pre-filled quick payment chips (*This item*, *Full balance*, *₱100*, *₱200*, *₱500*).
- **FIFO (First-In, First-Out) Multi-Batch Allocation**: Automatically clears the oldest batch debt first, showing which item is cleared and which has a remaining balance.
- Dynamically updates badges from *Unpaid* ➔ *With Balance* ➔ *Fully Paid*.

### 6. Offline-First PWA & Backup
- **PWA Manifest & Service Worker**: Installable on Android, iOS, and desktop browsers. Fully operational with zero internet connection.
- **Data & Backup Menu**:
  - Export backup: Download all customers and transactions as a `.json` file.
  - Import backup: Restore data from a JSON file.
  - Load sample data: Pre-load realistic Filipino meat shop demo accounts with multi-batch rolled-over debts.
  - Clear / reset database.

---

## 🚀 How to Run

1. Open this directory in your terminal:
   ```sh
   cd "C:\Users\Jin-Woo\.gemini\antigravity\scratch\meat-shop-pos"
   ```

2. To build Tailwind CSS:
   ```sh
   npm run build
   ```

3. To launch a local development server:
   ```sh
   npx -y serve -l 5173 .
   ```
   Or open `index.html` directly in any modern browser.
