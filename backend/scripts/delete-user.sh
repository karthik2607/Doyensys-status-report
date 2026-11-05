#!/usr/bin/env bash
# ===========================================================================
# DELETE A PORTAL USER
#
# Why this exists alongside `npm run remove-user`: the Prisma path issues its
# own UPDATE against audit_log while deleting, and the API's database role has
# no UPDATE grant on that table (the API only ever inserts there). Plain SQL
# doesn't hit that problem — Postgres applies foreign-key actions without
# checking the caller's table privileges — so this script gets the job done
# with the ordinary app credentials and no superuser access.
#
# Safety:
#   • Refuses if the account owns history (tickets raised, notes, uploads,
#     reports). That content references users with NOT NULL foreign keys, so
#     deleting the account would orphan it.
#   • The removal runs as a single transaction with ON_ERROR_STOP, so any
#     failure rolls everything back. There is no half-deleted state.
#   • Shows what it found before, and confirms the result after.
#
# Usage:
#   cd /opt/doyensys/doyensys-backend
#   chmod +x scripts/delete-user.sh            # once
#   ./scripts/delete-user.sh someone@example.com
# ===========================================================================
set -euo pipefail

EMAIL="${1:-}"
MODE="refuse"          # refuse | reassign | purge
REASSIGN_TO=""

shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --reassign-to)
      MODE="reassign"; REASSIGN_TO="${2:-}"; shift 2
      [ -n "$REASSIGN_TO" ] || { echo "ERROR: --reassign-to needs an email"; exit 1; }
      ;;
    --delete-content)
      MODE="purge"; shift
      ;;
    *)
      echo "ERROR: unknown option '$1'"; exit 1
      ;;
  esac
done

if [ -z "$EMAIL" ]; then
  cat <<'USAGE'
Usage:
  delete-user.sh <email>
      Deletes the account. Refuses if it owns any history.

  delete-user.sh <email> --reassign-to <other-email>
      Moves their tickets, notes, uploads and reports to the other account,
      then deletes them. History is preserved under the new owner.

  delete-user.sh <email> --delete-content
      DESTRUCTIVE. Deletes the tickets they raised (and every note, event,
      attachment and change record on those tickets) and the reports they
      authored, then deletes the account. Cannot be undone.

Examples:
  ./scripts/delete-user.sh karthik.sudhan@doyensys.com --reassign-to john.smith@abccorp.com
  ./scripts/delete-user.sh karthik.sudhan@doyensys.com --delete-content
USAGE
  exit 1
fi

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$BACKEND_DIR/.env"
[ -f "$ENV_FILE" ] || { echo "ERROR: cannot find $ENV_FILE"; exit 1; }

RAW_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')
# Prisma appends ?schema=public, which psql rejects: "invalid URI query
# parameter". Strip everything from the ? onwards.
DB_URL="${RAW_URL%%\?*}"
[ -n "$DB_URL" ] || { echo "ERROR: could not read DATABASE_URL from $ENV_FILE"; exit 1; }

PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1)

# --- does the account exist? ------------------------------------------------
UID_FOUND=$("${PSQL[@]}" -tAc "SELECT id FROM users WHERE email = '${EMAIL//\'/\'\'}';")
if [ -z "$UID_FOUND" ]; then
  echo "No user found with email: $EMAIL"
  exit 1
fi

echo "Found: $EMAIL  ($UID_FOUND)"
echo
echo "--- Attached records ---"
"${PSQL[@]}" -c "
SELECT
  (SELECT COUNT(*) FROM tickets               WHERE requestor_id   = u.id) AS tickets_raised,
  (SELECT COUNT(*) FROM ticket_notes          WHERE author_id      = u.id) AS notes,
  (SELECT COUNT(*) FROM ticket_attachments    WHERE uploaded_by_id = u.id) AS files,
  (SELECT COUNT(*) FROM change_history        WHERE by_id          = u.id) AS change_entries,
  (SELECT COUNT(*) FROM status_reports        WHERE author_id      = u.id) AS reports,
  (SELECT COUNT(*) FROM status_report_uploads WHERE uploaded_by_id = u.id) AS report_files,
  (SELECT COUNT(*) FROM tickets               WHERE assignee_id    = u.id) AS assigned,
  (SELECT COUNT(*) FROM notifications         WHERE user_id        = u.id) AS notifications
FROM users u WHERE u.id = '$UID_FOUND';"

# --- refuse if the account owns history -------------------------------------
BLOCKERS=$("${PSQL[@]}" -tAc "
SELECT
  (SELECT COUNT(*) FROM tickets               WHERE requestor_id   = '$UID_FOUND') +
  (SELECT COUNT(*) FROM ticket_notes          WHERE author_id      = '$UID_FOUND') +
  (SELECT COUNT(*) FROM ticket_attachments    WHERE uploaded_by_id = '$UID_FOUND') +
  (SELECT COUNT(*) FROM change_history        WHERE by_id          = '$UID_FOUND') +
  (SELECT COUNT(*) FROM status_reports        WHERE author_id      = '$UID_FOUND') +
  (SELECT COUNT(*) FROM status_report_uploads WHERE uploaded_by_id = '$UID_FOUND');")

if [ "$BLOCKERS" -gt 0 ] && [ "$MODE" = "refuse" ]; then
  echo
  echo "Cannot delete $EMAIL — it owns $BLOCKERS record(s) of history."
  echo "Tickets, notes, uploads and reports must keep a valid owner."
  echo
  echo "Re-run with one of these to proceed:"
  echo
  echo "  --reassign-to <email>   move that content to another account (keeps history)"
  echo "  --delete-content        delete that content as well (DESTRUCTIVE, permanent)"
  echo
  echo "Or leave the account in place and change its password instead:"
  echo "  npm run set-password"
  echo
  echo "Nothing was changed."
  exit 1
fi

# --- resolve the reassignment target ----------------------------------------
NEW_UID=""
if [ "$MODE" = "reassign" ]; then
  NEW_UID=$("${PSQL[@]}" -tAc "SELECT id FROM users WHERE email = '${REASSIGN_TO//\'/\'\'}';")
  [ -n "$NEW_UID" ] || { echo "ERROR: no user found with email $REASSIGN_TO"; exit 1; }
  [ "$NEW_UID" != "$UID_FOUND" ] || { echo "ERROR: cannot reassign an account to itself"; exit 1; }

  # Tickets carry their own org_id, so moving a requestor across orgs would
  # leave a ticket whose requestor belongs to a different customer. Warn
  # rather than block — there are legitimate cases (a support account taking
  # over) but it should never happen silently.
  SAME_ORG=$("${PSQL[@]}" -tAc "
    SELECT CASE WHEN a.org_id = b.org_id THEN 'yes' ELSE 'no' END
    FROM users a, users b WHERE a.id = '$UID_FOUND' AND b.id = '$NEW_UID';")
  echo
  echo "Reassigning all history to: $REASSIGN_TO"
  if [ "$SAME_ORG" != "yes" ]; then
    echo "WARNING: that account is in a DIFFERENT organization than $EMAIL."
    echo "         Tickets keep their own org, but their requestor would then"
    echo "         belong to another customer. Check this is what you want."
  fi
fi

if [ "$MODE" = "purge" ]; then
  echo
  echo "DESTRUCTIVE MODE — the following will be permanently deleted:"
  "${PSQL[@]}" -c "
  SELECT
    (SELECT COUNT(*) FROM tickets        WHERE requestor_id = '$UID_FOUND') AS tickets_and_all_their_notes_events_files,
    (SELECT COUNT(*) FROM ticket_notes   WHERE author_id    = '$UID_FOUND') AS notes_on_other_tickets,
    (SELECT COUNT(*) FROM status_reports WHERE author_id    = '$UID_FOUND') AS reports;"
  echo "This cannot be undone."
fi

# --- confirm ----------------------------------------------------------------
echo
read -r -p "Type the email to confirm deletion ($EMAIL): " CONFIRM
if [ "$CONFIRM" != "$EMAIL" ]; then
  echo "Email did not match. Nothing was changed."
  exit 1
fi

# --- remove -----------------------------------------------------------------
# Deliberately NO "UPDATE audit_log" here. Postgres checks table privileges
# per statement, not per row, so that UPDATE fails with "permission denied for
# table audit_log" even when it would match zero rows — which is precisely
# what breaks the Prisma version of this. The audit_log.actor_id foreign key
# is ON DELETE SET NULL, and Postgres applies foreign-key actions without
# consulting the caller's privileges, so the reference clears itself.

# Build the mode-specific part of the transaction.
HISTORY_SQL=""
if [ "$MODE" = "reassign" ]; then
  HISTORY_SQL="
  UPDATE tickets               SET requestor_id   = '$NEW_UID' WHERE requestor_id   = '$UID_FOUND';
  UPDATE ticket_notes          SET author_id      = '$NEW_UID' WHERE author_id      = '$UID_FOUND';
  UPDATE ticket_attachments    SET uploaded_by_id = '$NEW_UID' WHERE uploaded_by_id = '$UID_FOUND';
  UPDATE change_history        SET by_id          = '$NEW_UID' WHERE by_id          = '$UID_FOUND';
  UPDATE status_reports        SET author_id      = '$NEW_UID' WHERE author_id      = '$UID_FOUND';
  UPDATE status_report_uploads SET uploaded_by_id = '$NEW_UID' WHERE uploaded_by_id = '$UID_FOUND';
"
elif [ "$MODE" = "purge" ]; then
  # Order matters. Rows this user owns on OTHER people's tickets must go
  # first — they wouldn't be reached by any cascade. Deleting their own
  # tickets then cascades that ticket's notes, events, attachments, change
  # detail and change history automatically.
  HISTORY_SQL="
  DELETE FROM ticket_attachments    WHERE uploaded_by_id = '$UID_FOUND';
  DELETE FROM ticket_notes          WHERE author_id      = '$UID_FOUND';
  DELETE FROM change_history        WHERE by_id          = '$UID_FOUND';
  DELETE FROM status_report_uploads WHERE uploaded_by_id = '$UID_FOUND';
  DELETE FROM status_reports        WHERE author_id      = '$UID_FOUND';
  DELETE FROM tickets               WHERE requestor_id   = '$UID_FOUND';
"
fi

if ! "${PSQL[@]}" <<SQL
BEGIN;
$HISTORY_SQL
  UPDATE tickets SET assignee_id = NULL WHERE assignee_id = '$UID_FOUND';
  DELETE FROM notifications            WHERE user_id     = '$UID_FOUND';
  DELETE FROM users                    WHERE id          = '$UID_FOUND';
COMMIT;
SQL
then
  echo
  echo "The delete failed and was rolled back — nothing changed."
  echo
  echo "If the error above mentions audit_log, that foreign key is not"
  echo "ON DELETE SET NULL on this database. Clear it as a superuser first:"
  echo
  echo "  sudo -u postgres psql -d <database> \\"
  echo "    -c \"UPDATE audit_log SET actor_id = NULL WHERE actor_id = '$UID_FOUND';\""
  echo
  echo "then re-run this script."
  exit 1
fi

REMAINING=$("${PSQL[@]}" -tAc "SELECT COUNT(*) FROM users WHERE id = '$UID_FOUND';")
echo
if [ "$REMAINING" = "0" ]; then
  echo "Deleted $EMAIL."
else
  echo "WARNING: the account still exists. Nothing was committed."
  exit 1
fi
