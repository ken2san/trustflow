# Hire Mode Workflow: Detailed Design & Implementation Plan

## 1. Delivery & Approval Flow Design

### Step Structure

1. **Escrow Start**
   - UI: Display "Escrow funds locked"
   - Action: Progress bar, next action is "Awaiting Delivery"

2. **Awaiting Delivery**
   - UI: Clearly indicate "Awaiting Delivery"; show "Not Submitted" badge if no file
   - When file is submitted:
     - Show "Download" button (with version/timestamp)
     - Show "Delivery Message"
   - Action: Enable "Approve" or "Reject" buttons only after "Reviewed" checkbox is checked

3. **On Reject**
   - UI: Require input of rejection reason, automatically send re-delivery request
   - History: Add "Reject" action, reason, and timestamp to history
   - On re-delivery, show as "Version 2" etc. in history

4. **On Approval**
   - UI: Show confirmation dialog when "Approve" is clicked
   - After approval, move to "Rating" step

5. **Rating & Completion**
   - UI: Input rating (stars + comment), then show "Contract Complete" screen
   - History: Display all interactions, files, and actions in chronological order

---

## 2. Implementation Plan

### A. State Management

- `contractStep` (enum: ESCROW, WAIT_DELIVERABLE, REVIEW, REJECTED, RATING, COMPLETE)
- `deliverables` (array: {version, fileUrl, message, timestamp})
- `reviewStatus` (enum: PENDING, APPROVED, REJECTED, NEEDS_REVISION)
- `history` (array: {type, message, timestamp, actor})

### B. UI/UX

- Clearly display state at each step (progress bar, badges, explanatory text)
- When file is submitted: show "Download", "Preview", and "Version History"
- "Approve" and "Reject" buttons are enabled only after "Reviewed" checkbox is checked
- On reject: require reason input, show re-delivery request UI
- Show all actions, comments, and files in a chronological history panel
- For critical actions, show confirmation dialog and allow Undo (e.g., 5 seconds to cancel)

### C. Backend/Data

- File uploads stored in storage (e.g., Firebase Storage) with hash recorded
- All actions, comments, and files saved in DB with timestamp
- On dispute, automatically aggregate all history/files and send to admin/arbitrator

### D. Notifications & Communication

- Automatic notifications (email/in-app/chat) on delivery, reject, re-delivery, approval
- Chat history integrated with contract history

---

## 3. Implementation Priority & Roadmap Example

1. **File delivery & version management**
2. **Reject → re-delivery flow (reason input, re-delivery request)**
3. **Progress & history panel implementation**
4. **Confirmation dialog & Undo for approval/reject**
5. **Automatic evidence aggregation & admin notification on dispute**
6. **UI/UX fine-tuning (explanations, badges, responsive design, etc.)**

---

# Workflow Refactoring & Enhancement Plan (2026-02)

> **Note:** This section supersedes or supplements previous plans. Use this as the current reference for ongoing improvements and technical debt reduction.

## 1. Complexity Reduction & Refactoring

- **Logic Separation**: Move business logic (state management, history, validation, etc.) into custom hooks or utility functions. Keep ContractView and other UI components focused on rendering.
- **Modal/Dialog Unification**: Refactor approval, reject, dispute, and other dialogs into shared components to eliminate duplication and simplify maintenance.
- **State Management Simplification**: Consider useReducer or a state management library (Zustand, Recoil, etc.) to reduce prop drilling and deeply nested state.

## 2. Completion & Quality Improvements

- **Testing**: Add unit and E2E tests (Jest, React Testing Library, Cypress) to ensure reliability and prevent regressions.
- **Accessibility**: Improve keyboard navigation, screen reader support, and add ARIA attributes where appropriate.
- **Internationalization (i18n)**: Multi-language UI. There is no scaffolding to extend — the `src/i18n.js` stub this line used to point at was a no-op with no locales directory and was removed in Task 17.
- **UX Animation**: Add smooth transitions for step changes and key actions to enhance user experience.
- **API/DB Integration**: Replace local state with backend integration for file storage, history, and notifications.
- **User Guidance**: Add inline help, tooltips, or a quickstart guide to assist users with complex workflows.

---

> **Action:** All new enhancements and refactoring should be planned and tracked in this section. When implementing, reference this plan and update as needed.
