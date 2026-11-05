-- ============================================================================
-- Row-Level Security policies for the Doyensys ITSM portal.
-- Run AFTER `prisma migrate deploy` has created the tables.
--
-- Session variables set per-request via withTenantContext() (SET LOCAL,
-- inside a transaction — never persists across requests):
--   app.current_org_id   -- the caller's org (customer org id, or their
--                            Doyensys "support" org id)
--   app.role               -- 'CUSTOMER_ADMIN' | 'CUSTOMER_VIEWER'
--                            | 'SUPPORT_AGENT' | 'SUPPORT_MANAGER'
--   app.current_user_id   -- the caller's user id
--
-- Rule of thumb: SUPPORT_* roles see across all orgs (Doyensys staff serve
-- every customer). CUSTOMER_* roles are hard-scoped to their own org_id.
-- This is layer 2 — the application query layer (Prisma `where` clauses via
-- withTenantContext) is layer 1 and must not be removed just because RLS
-- exists; neither layer alone is sufficient.
-- ============================================================================

-- Helper: is the caller support staff?
CREATE OR REPLACE FUNCTION app_is_support() RETURNS boolean AS $$
  SELECT current_setting('app.role', true) IN ('SUPPORT_AGENT', 'SUPPORT_MANAGER');
$$ LANGUAGE sql STABLE;

-- NOTE: returns text, not uuid — Prisma's `String @id @default(uuid())`
-- creates a `text` column (no native Postgres uuid type), so these must
-- match that type or every comparison below fails with
-- "operator does not exist: text = uuid".
CREATE OR REPLACE FUNCTION app_current_org_id() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.current_org_id', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '');
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- orgs — customers can read only their own org row; support reads all
-- ---------------------------------------------------------------------------
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
CREATE POLICY orgs_select ON orgs FOR SELECT
  USING (app_is_support() OR id = app_current_org_id());

-- ---------------------------------------------------------------------------
-- org_settings
-- ---------------------------------------------------------------------------
ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_settings_select ON org_settings FOR SELECT
  USING (app_is_support() OR org_id = app_current_org_id());
CREATE POLICY org_settings_write ON org_settings FOR ALL
  USING (app_is_support()) WITH CHECK (app_is_support());

-- ---------------------------------------------------------------------------
-- users — customers see only users within their own org (for requestor
-- names etc.); support sees all
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT
  USING (app_is_support() OR org_id = app_current_org_id());

-- ---------------------------------------------------------------------------
-- projects / initiatives
-- ---------------------------------------------------------------------------
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY projects_select ON projects FOR SELECT
  USING (app_is_support() OR org_id = app_current_org_id());
CREATE POLICY projects_write ON projects FOR INSERT
  WITH CHECK (app_is_support() OR org_id = app_current_org_id());
CREATE POLICY projects_update ON projects FOR UPDATE
  USING (app_is_support() OR org_id = app_current_org_id());

-- ---------------------------------------------------------------------------
-- project_tasks — parsed from uploaded project-plan Excel files. Visibility
-- and write access follow the parent project's org, same rule as projects
-- itself (customers can create/update their own org's project plans now,
-- per product decision — not support-only like the rest of this schema).
-- ---------------------------------------------------------------------------
ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_tasks_select ON project_tasks FOR SELECT
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_tasks.project_id AND p.org_id = app_current_org_id()
  ));
CREATE POLICY project_tasks_write ON project_tasks FOR ALL
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_tasks.project_id AND p.org_id = app_current_org_id()
  ))
  WITH CHECK (app_is_support() OR EXISTS (
    SELECT 1 FROM projects p WHERE p.id = project_tasks.project_id AND p.org_id = app_current_org_id()
  ));

ALTER TABLE initiatives ENABLE ROW LEVEL SECURITY;
CREATE POLICY initiatives_select ON initiatives FOR SELECT
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM projects p WHERE p.id = initiatives.project_id AND p.org_id = app_current_org_id()
  ));
CREATE POLICY initiatives_write ON initiatives FOR INSERT WITH CHECK (app_is_support());

-- ---------------------------------------------------------------------------
-- tickets (incidents / requests / changes share this table)
-- Customers see only their own org's tickets. Support sees all.
-- ---------------------------------------------------------------------------
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tickets_select ON tickets FOR SELECT
  USING (app_is_support() OR org_id = app_current_org_id());
CREATE POLICY tickets_insert ON tickets FOR INSERT
  WITH CHECK (app_is_support() OR org_id = app_current_org_id());
CREATE POLICY tickets_update ON tickets FOR UPDATE
  USING (app_is_support() OR org_id = app_current_org_id());

-- ---------------------------------------------------------------------------
-- ticket_notes — the important one: CUSTOMER-role sessions must never see
-- visibility='INTERNAL' rows, full stop. This is enforced here AND at the
-- Prisma query layer (belt and suspenders, per your existing design).
-- ---------------------------------------------------------------------------
ALTER TABLE ticket_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_notes_select ON ticket_notes FOR SELECT
  USING (
    (app_is_support() OR EXISTS (
      SELECT 1 FROM tickets t WHERE t.id = ticket_notes.ticket_id AND t.org_id = app_current_org_id()
    ))
    AND (app_is_support() OR visibility = 'CUSTOMER')
  );
CREATE POLICY ticket_notes_insert ON ticket_notes FOR INSERT
  WITH CHECK (
    app_is_support() OR (
      visibility = 'CUSTOMER' AND EXISTS (
        SELECT 1 FROM tickets t WHERE t.id = ticket_notes.ticket_id AND t.org_id = app_current_org_id()
      )
    )
  );

-- ---------------------------------------------------------------------------
-- ticket_events (timeline) — same org visibility as the parent ticket
-- ---------------------------------------------------------------------------
ALTER TABLE ticket_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_events_select ON ticket_events FOR SELECT
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM tickets t WHERE t.id = ticket_events.ticket_id AND t.org_id = app_current_org_id()
  ));
CREATE POLICY ticket_events_insert ON ticket_events FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- ticket_attachments — inherits visibility from parent note if set,
-- otherwise from the parent ticket's org
-- ---------------------------------------------------------------------------
ALTER TABLE ticket_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_attachments_select ON ticket_attachments FOR SELECT
  USING (
    app_is_support() OR (
      EXISTS (SELECT 1 FROM tickets t WHERE t.id = ticket_attachments.ticket_id AND t.org_id = app_current_org_id())
      AND (
        note_id IS NULL OR EXISTS (
          SELECT 1 FROM ticket_notes n WHERE n.id = ticket_attachments.note_id AND n.visibility = 'CUSTOMER'
        )
      )
    )
  );
CREATE POLICY ticket_attachments_insert ON ticket_attachments FOR INSERT
  WITH CHECK (app_is_support() OR EXISTS (
    SELECT 1 FROM tickets t WHERE t.id = ticket_attachments.ticket_id AND t.org_id = app_current_org_id()
  ));

-- ---------------------------------------------------------------------------
-- change_details / change_history — visibility follows the parent ticket
-- ---------------------------------------------------------------------------
ALTER TABLE change_details ENABLE ROW LEVEL SECURITY;
CREATE POLICY change_details_select ON change_details FOR SELECT
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM tickets t WHERE t.id = change_details.ticket_id AND t.org_id = app_current_org_id()
  ));
CREATE POLICY change_details_update ON change_details FOR UPDATE
  USING (true); -- stage transitions are gated in application code (workflow.ts), not here

ALTER TABLE change_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY change_history_select ON change_history FOR SELECT
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM change_details cd JOIN tickets t ON t.id = cd.ticket_id
    WHERE cd.ticket_id = change_history.change_id AND t.org_id = app_current_org_id()
  ));
CREATE POLICY change_history_insert ON change_history FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- status_reports and children — customers see PUBLISHED reports for their
-- org only; support sees all (including unpublished drafts)
-- ---------------------------------------------------------------------------
ALTER TABLE status_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY status_reports_select ON status_reports FOR SELECT
  USING (
    app_is_support() OR (org_id = app_current_org_id() AND is_published = true)
  );
CREATE POLICY status_reports_write ON status_reports FOR ALL
  USING (app_is_support()) WITH CHECK (app_is_support());

ALTER TABLE status_report_list_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY sr_list_items_select ON status_report_list_items FOR SELECT
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM status_reports r WHERE r.id = status_report_list_items.report_id
      AND r.org_id = app_current_org_id() AND r.is_published = true
  ));
CREATE POLICY sr_list_items_write ON status_report_list_items FOR ALL
  USING (app_is_support()) WITH CHECK (app_is_support());

ALTER TABLE status_report_risks ENABLE ROW LEVEL SECURITY;
CREATE POLICY sr_risks_select ON status_report_risks FOR SELECT
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM status_reports r WHERE r.id = status_report_risks.report_id
      AND r.org_id = app_current_org_id() AND r.is_published = true
  ));
CREATE POLICY sr_risks_write ON status_report_risks FOR ALL
  USING (app_is_support()) WITH CHECK (app_is_support());

ALTER TABLE status_report_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY sr_issues_select ON status_report_issues FOR SELECT
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM status_reports r WHERE r.id = status_report_issues.report_id
      AND r.org_id = app_current_org_id() AND r.is_published = true
  ));
CREATE POLICY sr_issues_write ON status_report_issues FOR ALL
  USING (app_is_support()) WITH CHECK (app_is_support());

ALTER TABLE status_report_milestones ENABLE ROW LEVEL SECURITY;
CREATE POLICY sr_milestones_select ON status_report_milestones FOR SELECT
  USING (app_is_support() OR EXISTS (
    SELECT 1 FROM status_reports r WHERE r.id = status_report_milestones.report_id
      AND r.org_id = app_current_org_id() AND r.is_published = true
  ));
CREATE POLICY sr_milestones_write ON status_report_milestones FOR ALL
  USING (app_is_support()) WITH CHECK (app_is_support());

-- ---------------------------------------------------------------------------
-- status_report_uploads — file-based reports. Customers see them (they're
-- published the moment they're uploaded, no draft state); only support can
-- upload/replace.
-- ---------------------------------------------------------------------------
ALTER TABLE status_report_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY sr_uploads_select ON status_report_uploads FOR SELECT
  USING (app_is_support() OR org_id = app_current_org_id());
CREATE POLICY sr_uploads_write ON status_report_uploads FOR ALL
  USING (app_is_support()) WITH CHECK (app_is_support());

-- ---------------------------------------------------------------------------
-- notifications — strictly per-user, regardless of role
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_select ON notifications FOR SELECT
  USING (user_id = app_current_user_id());
CREATE POLICY notifications_update ON notifications FOR UPDATE
  USING (user_id = app_current_user_id());
CREATE POLICY notifications_insert ON notifications FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- company_updates — visible to everyone, writable by support only
-- ---------------------------------------------------------------------------
ALTER TABLE company_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_updates_select ON company_updates FOR SELECT USING (true);
CREATE POLICY company_updates_write ON company_updates FOR ALL
  USING (app_is_support()) WITH CHECK (app_is_support());

-- ---------------------------------------------------------------------------
-- audit_log — INSERT-only for the doyensys_app runtime role (no UPDATE/DELETE
-- policy is defined at all, which means those operations are refused outright
-- for any non-superuser). Reads are support-only.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_select ON audit_log FOR SELECT USING (app_is_support());
CREATE POLICY audit_log_insert ON audit_log FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Grants for the doyensys_app runtime role
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  orgs, org_settings, users, projects, initiatives, project_tasks, tickets, ticket_notes,
  ticket_events, ticket_attachments, change_details, change_history,
  status_reports, status_report_list_items, status_report_risks,
  status_report_issues, status_report_milestones, status_report_uploads,
  notifications, company_updates
  TO doyensys_app;

-- audit_log: INSERT-only, matching your least-privilege design
GRANT SELECT, INSERT ON audit_log TO doyensys_app;
REVOKE UPDATE, DELETE ON audit_log FROM doyensys_app;
