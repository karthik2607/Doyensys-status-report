import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/services/authService';
import fs from 'node:fs';
import path from 'node:path';

const prisma = new PrismaClient();

// Default password for every seeded user — change after first login.
// Kept as a named constant so it's easy to find/rotate in one place.
const SEED_PASSWORD = 'Doyensys@2026';

async function main() {
  console.log('Seeding orgs...');
  const abcCorp = await prisma.org.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: { name: 'MOREgroup Inc' }, // applies the rename even if this org already exists from an earlier seed
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'MOREgroup Inc',
      type: 'CUSTOMER',
    },
  });

  const doyensys = await prisma.org.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Doyensys',
      type: 'DOYENSYS',
    },
  });

  await prisma.orgSettings.upsert({
    where: { orgId: abcCorp.id },
    update: {},
    create: {
      orgId: abcCorp.id,
      supportEmail: 'support@doyensys.com',
      supportPhone: '+1 (800) 555-0182',
      accountManager: 'Narasimha Rao Karanam',
      emergencySupport: '+1 (800) 555-0199',
      customerSupportUrl: null,
    },
  });

  console.log('Seeding users...');
  const passwordHash = await hashPassword(SEED_PASSWORD);

  const johnSmith = await prisma.user.upsert({
    where: { email: 'john.smith@abccorp.com' },
    update: {},
    create: {
      email: 'john.smith@abccorp.com',
      passwordHash,
      name: 'John Smith',
      initials: 'JS',
      role: 'CUSTOMER_ADMIN',
      orgId: abcCorp.id,
    },
  });

  await prisma.user.upsert({
    where: { email: 'dana.whitfield@abccorp.com' },
    update: {},
    create: {
      email: 'dana.whitfield@abccorp.com',
      passwordHash,
      name: 'Dana Whitfield',
      initials: 'DW',
      role: 'CUSTOMER_VIEWER',
      orgId: abcCorp.id,
    },
  });

  const raviKumar = await prisma.user.upsert({
    where: { email: 'ravi.kumar@doyensys.com' },
    update: {},
    create: {
      email: 'ravi.kumar@doyensys.com',
      passwordHash,
      name: 'Ravi Kumar',
      initials: 'RK',
      role: 'SUPPORT_AGENT',
      orgId: doyensys.id,
    },
  });

  await prisma.user.upsert({
    where: { email: 'sarah.chen@doyensys.com' },
    update: {},
    create: {
      email: 'sarah.chen@doyensys.com',
      passwordHash,
      name: 'Sarah Chen',
      initials: 'SC',
      role: 'SUPPORT_MANAGER',
      orgId: doyensys.id,
    },
  });

  console.log('Seeding company updates...');
  await prisma.companyUpdate.createMany({
    data: [
      {
        title: 'Doyensys launches CloudFinX for AI cost visibility',
        desc: 'A new FinOps module tracks Azure spend and AI/Cognitive Services consumption side-by-side, live before billing begins.',
        date: new Date('2026-08-28'),
        category: 'Product Release',
        icon: '🚀',
        author: 'Doyensys Product Team',
        priority: 'High',
      },
      {
        title: 'Scheduled maintenance window — Sep 6, 11pm–1am CST',
        desc: 'Routine platform maintenance. No customer-facing downtime is expected; monitoring dashboards may be briefly unavailable.',
        date: new Date('2026-08-25'),
        category: 'Maintenance',
        icon: '🛠️',
        author: 'Doyensys Ops',
        priority: 'Medium',
      },
    ],
    skipDuplicates: true,
  });

  console.log('Seeding a project...');
  const project = await prisma.project.upsert({
    where: { id: '00000000-0000-0000-0000-000000000101' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000101',
      orgId: abcCorp.id,
      name: 'Oracle Cloud Migration',
      pm: 'Sarah Chen',
      health: 'ON_TRACK',
      progress: 72,
      phase: 'UAT',
    },
  });

  await prisma.initiative.createMany({
    data: [
      { projectId: project.id, date: new Date('2026-09-10'), title: 'UAT Completion', sub: 'Oracle Cloud Migration' },
      { projectId: project.id, date: new Date('2026-09-15'), title: 'Production Readiness Review', sub: 'Oracle Cloud Migration' },
      { projectId: project.id, date: new Date('2026-09-20'), title: 'Production Deployment', sub: 'Oracle Cloud Migration' },
    ],
    skipDuplicates: true,
  });

  console.log('Seeding demo projects...');
  // Demo/showcase projects with real task/phase data (via ProjectTask), so
  // the sidebar's per-project nav, Home's "Upcoming" widget, and the
  // Project Status page all have realistic multi-project data to show.
  type DemoTask = { phase: string; taskName: string; owner: string; startOffsetDays: number; endOffsetDays: number; percentComplete: number };
  const demoProjects: {
    id: string; name: string; pm: string; health: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK'; tasks: DemoTask[];
  }[] = [
    {
      id: '00000000-0000-0000-0000-000000000102',
      name: 'Data Platform Modernization',
      pm: 'Ravi Kumar',
      health: 'ON_TRACK',
      tasks: [
        { phase: 'Discovery', taskName: 'Current-state data architecture assessment', owner: 'Ravi Kumar', startOffsetDays: -40, endOffsetDays: -30, percentComplete: 1 },
        { phase: 'Discovery', taskName: 'Stakeholder requirements workshops', owner: 'Sarah Chen', startOffsetDays: -38, endOffsetDays: -28, percentComplete: 1 },
        { phase: 'Design', taskName: 'Target Snowflake schema design', owner: 'Ravi Kumar', startOffsetDays: -27, endOffsetDays: -10, percentComplete: 1 },
        { phase: 'Design', taskName: 'ETL pipeline architecture', owner: 'Sarah Chen', startOffsetDays: -20, endOffsetDays: 5, percentComplete: 0.6 },
        { phase: 'Build', taskName: 'Build ingestion pipelines — finance & HR feeds', owner: 'Ravi Kumar', startOffsetDays: -5, endOffsetDays: 12, percentComplete: 0.3 },
        { phase: 'Build', taskName: 'Build ingestion pipelines — CRM feed', owner: 'Sarah Chen', startOffsetDays: 3, endOffsetDays: 20, percentComplete: 0 },
        { phase: 'Test', taskName: 'Data quality validation & reconciliation', owner: 'Ravi Kumar', startOffsetDays: 21, endOffsetDays: 35, percentComplete: 0 },
      ],
    },
    {
      id: '00000000-0000-0000-0000-000000000103',
      name: 'RDS to OCI Migration',
      pm: 'Sarah Chen',
      health: 'AT_RISK',
      tasks: [
        { phase: 'Planning', taskName: 'Migration runbook & rollback plan', owner: 'Sarah Chen', startOffsetDays: -25, endOffsetDays: -15, percentComplete: 1 },
        { phase: 'Planning', taskName: 'Downtime window sign-off with customer', owner: 'John Smith', startOffsetDays: -18, endOffsetDays: -12, percentComplete: 1 },
        { phase: 'Migration', taskName: 'Schema & data migration — staging', owner: 'Ravi Kumar', startOffsetDays: -10, endOffsetDays: 2, percentComplete: 0.7 },
        { phase: 'Migration', taskName: 'Application connection string cutover', owner: 'Ravi Kumar', startOffsetDays: 3, endOffsetDays: 8, percentComplete: 0 },
        { phase: 'Validation', taskName: 'Performance benchmarking on OCI', owner: 'Sarah Chen', startOffsetDays: 9, endOffsetDays: 16, percentComplete: 0 },
        { phase: 'Validation', taskName: 'Production cutover & smoke tests', owner: 'Ravi Kumar', startOffsetDays: 17, endOffsetDays: 20, percentComplete: 0 },
      ],
    },
    {
      id: '00000000-0000-0000-0000-000000000104',
      name: 'Customer Portal Revamp',
      pm: 'Dana Whitfield',
      health: 'ON_TRACK',
      tasks: [
        { phase: 'Design', taskName: 'UX research & wireframes', owner: 'Dana Whitfield', startOffsetDays: -30, endOffsetDays: -18, percentComplete: 1 },
        { phase: 'Design', taskName: 'Visual design system', owner: 'Sarah Chen', startOffsetDays: -20, endOffsetDays: -6, percentComplete: 1 },
        { phase: 'Development', taskName: 'Build responsive component library', owner: 'Ravi Kumar', startOffsetDays: -8, endOffsetDays: 10, percentComplete: 0.5 },
        { phase: 'Development', taskName: 'Integrate ticketing & status report APIs', owner: 'Ravi Kumar', startOffsetDays: 5, endOffsetDays: 18, percentComplete: 0.1 },
        { phase: 'Launch', taskName: 'UAT with pilot customer group', owner: 'Dana Whitfield', startOffsetDays: 19, endOffsetDays: 28, percentComplete: 0 },
      ],
    },
    {
      id: '00000000-0000-0000-0000-000000000105',
      name: 'Network Security Hardening',
      pm: 'Ravi Kumar',
      health: 'OFF_TRACK',
      tasks: [
        { phase: 'Assessment', taskName: 'External penetration test', owner: 'Ravi Kumar', startOffsetDays: -35, endOffsetDays: -25, percentComplete: 1 },
        { phase: 'Assessment', taskName: 'Findings triage & remediation plan', owner: 'Sarah Chen', startOffsetDays: -24, endOffsetDays: -16, percentComplete: 1 },
        { phase: 'Remediation', taskName: 'Patch critical CVEs on edge firewalls', owner: 'Ravi Kumar', startOffsetDays: -14, endOffsetDays: -1, percentComplete: 0.8 },
        { phase: 'Remediation', taskName: 'MFA rollout for remaining admin accounts', owner: 'Sarah Chen', startOffsetDays: -2, endOffsetDays: 6, percentComplete: 0.2 },
        { phase: 'Remediation', taskName: 'Network segmentation for finance VLAN', owner: 'Ravi Kumar', startOffsetDays: 1, endOffsetDays: 9, percentComplete: 0 },
        { phase: 'Verification', taskName: 'Re-test & close out findings', owner: 'Sarah Chen', startOffsetDays: 10, endOffsetDays: 17, percentComplete: 0 },
      ],
    },
    {
      id: '00000000-0000-0000-0000-000000000106',
      name: 'Finance Reporting Automation',
      pm: 'Sarah Chen',
      health: 'ON_TRACK',
      tasks: [
        { phase: 'Requirements', taskName: 'Map existing manual reporting workflow', owner: 'John Smith', startOffsetDays: -22, endOffsetDays: -14, percentComplete: 1 },
        { phase: 'Build', taskName: 'Automate monthly close report generation', owner: 'Sarah Chen', startOffsetDays: -13, endOffsetDays: 0, percentComplete: 0.9 },
        { phase: 'Build', taskName: 'Automate board-deck data refresh', owner: 'Ravi Kumar', startOffsetDays: 1, endOffsetDays: 11, percentComplete: 0.2 },
        { phase: 'Rollout', taskName: 'Train finance team on new workflow', owner: 'Sarah Chen', startOffsetDays: 12, endOffsetDays: 15, percentComplete: 0 },
      ],
    },
    {
      id: '00000000-0000-0000-0000-000000000107',
      name: 'Mobile App Accessibility Upgrade',
      pm: 'Dana Whitfield',
      health: 'AT_RISK',
      tasks: [
        { phase: 'Audit', taskName: 'WCAG 2.2 AA compliance audit', owner: 'Dana Whitfield', startOffsetDays: -28, endOffsetDays: -20, percentComplete: 1 },
        { phase: 'Remediation', taskName: 'Fix contrast & focus-order issues', owner: 'Ravi Kumar', startOffsetDays: -19, endOffsetDays: -3, percentComplete: 0.7 },
        { phase: 'Remediation', taskName: 'Screen-reader labeling pass', owner: 'Ravi Kumar', startOffsetDays: -2, endOffsetDays: 7, percentComplete: 0.15 },
        { phase: 'Verification', taskName: 'Third-party accessibility re-audit', owner: 'Dana Whitfield', startOffsetDays: 8, endOffsetDays: 14, percentComplete: 0 },
      ],
    },
  ];

  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  for (const dp of demoProjects) {
    const demo = await prisma.project.upsert({
      where: { id: dp.id },
      update: { name: dp.name, pm: dp.pm, health: dp.health },
      create: { id: dp.id, orgId: abcCorp.id, name: dp.name, pm: dp.pm, health: dp.health, progress: 0, phase: dp.tasks[0]?.phase ?? 'Not Started' },
    });
    const existingTaskCount = await prisma.projectTask.count({ where: { projectId: demo.id } });
    if (existingTaskCount === 0) {
      await prisma.projectTask.createMany({
        data: dp.tasks.map((t, idx) => ({
          projectId: demo.id,
          phase: t.phase,
          taskName: t.taskName,
          owner: t.owner,
          startDate: new Date(today.getTime() + t.startOffsetDays * dayMs),
          endDate: new Date(today.getTime() + t.endOffsetDays * dayMs),
          percentComplete: t.percentComplete,
          sortOrder: idx,
        })),
      });
    }
  }

  console.log('Seeding sample tickets...');
  const incident = await prisma.ticket.upsert({
    where: { id: '00000000-0000-0000-0000-000000000201' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000201',
      orgId: abcCorp.id,
      type: 'INCIDENT',
      title: 'SSO login intermittently failing for finance team',
      description: 'Several finance users are getting bounced back to the login screen after SSO redirect.',
      priority: 'P1',
      status: 'IN_PROGRESS',
      category: 'Access',
      requestorId: johnSmith.id,
      assigneeId: raviKumar.id,
      responseSlaDueAt: new Date(Date.now() + 1000 * 60 * 60 * 2),
      resolutionSlaDueAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
    },
  });
  await prisma.ticketNote.createMany({
    data: [
      { ticketId: incident.id, authorId: johnSmith.id, visibility: 'CUSTOMER', body: 'Several finance users are getting bounced back to the login screen after SSO redirect.' },
      { ticketId: incident.id, authorId: raviKumar.id, visibility: 'INTERNAL', body: 'Checked Entra sign-in logs — investigating conditional access policy change from last week.' },
      { ticketId: incident.id, authorId: raviKumar.id, visibility: 'CUSTOMER', body: "We've identified a likely cause and are validating a fix now." },
    ],
    skipDuplicates: true,
  });
  await prisma.ticketEvent.createMany({
    data: [
      { ticketId: incident.id, eventText: 'Ticket created by John Smith' },
      { ticketId: incident.id, eventText: 'Assigned to Support Team' },
      { ticketId: incident.id, eventText: 'Support investigating' },
    ],
    skipDuplicates: true,
  });

  const requestTicket = await prisma.ticket.upsert({
    where: { id: '00000000-0000-0000-0000-000000000202' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000202',
      orgId: abcCorp.id,
      type: 'REQUEST',
      title: 'New portal access for two finance analysts',
      description: 'Please provision portal access for Maria Lopez and Tom Reyes on the finance team.',
      priority: 'P3',
      status: 'IN_PROGRESS',
      category: 'Access Request',
      requestorId: johnSmith.id,
      assigneeId: raviKumar.id,
    },
  });

  const changeTicket = await prisma.ticket.upsert({
    where: { id: '00000000-0000-0000-0000-000000000203' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000203',
      orgId: abcCorp.id,
      type: 'CHANGE',
      title: 'Oracle database configuration tuning for reporting performance',
      description: 'Reporting queries against the finance schema are taking 8-12s during peak hours.',
      priority: 'P2',
      requestorId: johnSmith.id,
      assigneeId: raviKumar.id,
    },
  });
  await prisma.changeDetail.upsert({
    where: { ticketId: changeTicket.id },
    update: {},
    create: {
      ticketId: changeTicket.id,
      risk: 'MEDIUM',
      justification: 'Reporting queries against the finance schema are taking 8-12s during peak hours; index and parameter tuning should bring this under 2s.',
      impact: 'No expected customer downtime. Tuning applied during a maintenance window.',
      implementation: 'Apply updated statistics targets, add two composite indexes on FIN_LEDGER, adjust PGA aggregate target.',
      rollback: 'Revert parameter file and drop new indexes; rollback tested and takes under 5 minutes.',
      stage: 'DEV_REVIEW',
      devNotes: 'Indexes created on FIN_LEDGER(customer_id, period). Query time improved from 9.4s to 1.7s in benchmark.',
      devById: raviKumar.id,
      devCompletedAt: new Date(),
    },
  });
  await prisma.changeHistory.createMany({
    data: [
      { changeId: changeTicket.id, stage: 'Raised', byId: johnSmith.id, note: 'Change request submitted.' },
      { changeId: changeTicket.id, stage: 'Customer Approval', byId: johnSmith.id, note: 'Approved — please proceed to development.' },
      { changeId: changeTicket.id, stage: 'DEV Review', byId: raviKumar.id, note: 'Development complete, submitted for customer review.' },
    ],
    skipDuplicates: true,
  });

  console.log('Seeding historical tickets for trend charts...');
  // Spread across the last ~10 weeks / 3 months with a mix of priority and
  // category so week/month trend charts (incoming vs closed, by severity
  // and module) have something real to show in the demo.
  type DemoTicket = {
    idSuffix: string; type: 'INCIDENT' | 'REQUEST' | 'CHANGE'; title: string; priority: 'P1' | 'P2' | 'P3' | 'P4';
    category: string; createdOffsetDays: number; status: 'RAISED' | 'RESPONDED' | 'IN_PROGRESS' | 'WAITING_ON_CUSTOMER' | 'RESOLVED' | 'CLOSED';
    resolvedOffsetDays?: number;
  };
  const demoTickets: DemoTicket[] = [
    { idSuffix: '210', type: 'INCIDENT', title: 'VPN client failing to connect for remote staff', priority: 'P2', category: 'Access', createdOffsetDays: -68, status: 'CLOSED', resolvedOffsetDays: -66 },
    { idSuffix: '211', type: 'INCIDENT', title: 'Reporting dashboard timing out on large queries', priority: 'P3', category: 'Application', createdOffsetDays: -63, status: 'CLOSED', resolvedOffsetDays: -60 },
    { idSuffix: '212', type: 'REQUEST', title: 'New laptop provisioning for onboarding batch', priority: 'P4', category: 'Hardware', createdOffsetDays: -60, status: 'CLOSED', resolvedOffsetDays: -55 },
    { idSuffix: '213', type: 'INCIDENT', title: 'Email delivery delays from ticket notifications', priority: 'P2', category: 'Application', createdOffsetDays: -54, status: 'CLOSED', resolvedOffsetDays: -52 },
    { idSuffix: '214', type: 'CHANGE', title: 'Upgrade load balancer firmware', priority: 'P2', category: 'Infrastructure', createdOffsetDays: -50, status: 'RESOLVED', resolvedOffsetDays: -44 },
    { idSuffix: '215', type: 'REQUEST', title: 'Access request for new finance intern', priority: 'P3', category: 'Access Request', createdOffsetDays: -47, status: 'CLOSED', resolvedOffsetDays: -45 },
    { idSuffix: '216', type: 'INCIDENT', title: 'Intermittent 502 errors on customer portal', priority: 'P1', category: 'Application', createdOffsetDays: -42, status: 'CLOSED', resolvedOffsetDays: -41 },
    { idSuffix: '217', type: 'INCIDENT', title: 'Printer queue stuck on 3rd floor finance office', priority: 'P4', category: 'Hardware', createdOffsetDays: -38, status: 'CLOSED', resolvedOffsetDays: -37 },
    { idSuffix: '218', type: 'REQUEST', title: 'Additional storage quota for shared drive', priority: 'P3', category: 'Access Request', createdOffsetDays: -34, status: 'RESOLVED', resolvedOffsetDays: -31 },
    { idSuffix: '219', type: 'CHANGE', title: 'Rotate database service account credentials', priority: 'P3', category: 'Infrastructure', createdOffsetDays: -30, status: 'CLOSED', resolvedOffsetDays: -27 },
    { idSuffix: '220', type: 'INCIDENT', title: 'SSL certificate expiry warning on portal domain', priority: 'P2', category: 'Application', createdOffsetDays: -26, status: 'CLOSED', resolvedOffsetDays: -25 },
    { idSuffix: '221', type: 'INCIDENT', title: 'Slow file upload on status report page', priority: 'P3', category: 'Application', createdOffsetDays: -22, status: 'RESOLVED', resolvedOffsetDays: -19 },
    { idSuffix: '222', type: 'REQUEST', title: 'New CUSTOMER_VIEWER account for audit team', priority: 'P4', category: 'Access Request', createdOffsetDays: -18, status: 'CLOSED', resolvedOffsetDays: -16 },
    { idSuffix: '223', type: 'INCIDENT', title: 'Login page unresponsive during peak hours', priority: 'P1', category: 'Access', createdOffsetDays: -15, status: 'RESOLVED', resolvedOffsetDays: -14 },
    { idSuffix: '224', type: 'CHANGE', title: 'Add composite index to speed up ticket search', priority: 'P3', category: 'Infrastructure', createdOffsetDays: -12, status: 'RESOLVED', resolvedOffsetDays: -9 },
    { idSuffix: '225', type: 'INCIDENT', title: 'Mobile view broken on ticket detail page', priority: 'P3', category: 'Application', createdOffsetDays: -9, status: 'IN_PROGRESS' },
    { idSuffix: '226', type: 'REQUEST', title: 'New report subscription for weekly digest', priority: 'P4', category: 'Access Request', createdOffsetDays: -7, status: 'RESPONDED' },
    { idSuffix: '227', type: 'INCIDENT', title: 'Notification bell count out of sync', priority: 'P2', category: 'Application', createdOffsetDays: -5, status: 'IN_PROGRESS' },
    { idSuffix: '228', type: 'INCIDENT', title: 'File attachment upload failing over 20MB', priority: 'P3', category: 'Application', createdOffsetDays: -3, status: 'RAISED' },
    { idSuffix: '229', type: 'REQUEST', title: 'Provision access for new PM on Data Platform project', priority: 'P3', category: 'Access Request', createdOffsetDays: -1, status: 'RAISED' },
  ];
  for (const dt of demoTickets) {
    const id = `00000000-0000-0000-0000-000000000${dt.idSuffix}`;
    const createdAt = new Date(today.getTime() + dt.createdOffsetDays * dayMs);
    const resolvedAt = dt.resolvedOffsetDays != null ? new Date(today.getTime() + dt.resolvedOffsetDays * dayMs) : null;
    const existing = await prisma.ticket.findUnique({ where: { id } });
    if (existing) continue; // don't overwrite createdAt on re-seed (it's not updatable via upsert's `update` without forcing it)
    const ticket = await prisma.ticket.create({
      data: {
        id, orgId: abcCorp.id, type: dt.type, title: dt.title,
        description: `${dt.title} — seeded demo ticket for trend reporting.`,
        priority: dt.priority, status: dt.type === 'CHANGE' ? null : dt.status, category: dt.category,
        requestorId: johnSmith.id, assigneeId: raviKumar.id,
        createdAt, resolvedAt,
      },
    });
    if (dt.type === 'CHANGE') {
      await prisma.changeDetail.create({
        data: {
          ticketId: ticket.id, risk: 'LOW',
          justification: `${dt.title} — routine change.`, impact: 'No expected customer downtime.',
          implementation: 'Applied during a scheduled maintenance window.', rollback: 'Revert configuration; tested rollback under 5 minutes.',
          stage: dt.status === 'CLOSED' ? 'CLOSED' : dt.status === 'RESOLVED' ? 'RESOLVED' : 'DEV',
        },
      });
    }
  }

  console.log('Seeding notifications...');
  await prisma.notification.createMany({
    data: [
      { orgId: abcCorp.id, userId: johnSmith.id, title: 'Change is ready for your review', sub: 'Development is complete — Ravi Kumar submitted it for your review.', category: 'CHANGE', refType: 'ticket', refId: changeTicket.id },
      { orgId: abcCorp.id, userId: johnSmith.id, title: 'Incident update posted', sub: 'Ravi Kumar posted a customer update on your P1 incident.', category: 'TICKET', refType: 'ticket', refId: incident.id },
      { orgId: doyensys.id, userId: raviKumar.id, title: 'New incident assigned to you', sub: incident.title, category: 'TICKET', refType: 'ticket', refId: incident.id },
    ],
    skipDuplicates: true,
  });

  console.log('Seeding a status report...');
  await prisma.statusReport.upsert({
    where: { id: '00000000-0000-0000-0000-000000000301' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000301',
      orgId: abcCorp.id, projectId: project.id, type: 'WEEKLY',
      period: 'Aug 25 – Sep 1, 2026', periodStart: new Date('2026-08-25'), periodEnd: new Date('2026-09-01'),
      authorId: raviKumar.id,
      summary: 'UAT is progressing well with 72% overall completion. One medium risk identified around third-party API rate limits; mitigation in progress. No change to planned go-live date.',
      healthOverall: 'ON_TRACK', healthSchedule: 'ON_TRACK', healthBudget: 'ON_TRACK', healthScope: 'STABLE', healthQuality: 'GOOD',
      itsmOpenIncidents: 1, itsmOpenRequests: 2, itsmChanges: 2, itsmSlaPerf: '98%',
      isPublished: true, publishedAt: new Date('2026-09-01'),
      listItems: {
        create: [
          { section: 'COMPLETED', text: 'Migrated finance and procurement modules to Oracle Cloud', sortOrder: 0 },
          { section: 'COMPLETED', text: 'Completed data reconciliation for 4 of 6 legacy systems', sortOrder: 1 },
          { section: 'IN_PROGRESS', text: 'UAT execution for finance and procurement (day 4 of 10)', sortOrder: 0 },
          { section: 'IN_PROGRESS', text: 'Performance tuning for reporting queries (see change request)', sortOrder: 1 },
          { section: 'PLANNED', text: 'Complete remaining data reconciliation (HR, Inventory)', sortOrder: 0 },
          { section: 'PLANNED', text: 'Begin UAT for supply chain workstream', sortOrder: 1 },
          { section: 'UPCOMING', text: 'UAT sign-off meeting — Sep 8', sortOrder: 0 },
          { section: 'CUSTOMER_ACTIONS', text: 'Review and approve pending reporting performance change', sortOrder: 0 },
        ],
      },
      risks: { create: [{ description: 'Third-party tax engine API has intermittent rate-limiting under peak load.', impact: 'Medium', probability: 'Medium', mitigation: 'Implementing request batching and caching layer.', owner: 'Marcus Webb' }] },
      issues: { create: [{ issue: 'Reporting query performance below target during UAT.', impact: 'Medium', resolution: 'Index/parameter tuning in progress.', owner: 'Ravi Kumar', targetDate: 'Sep 3, 2026' }] },
      milestones: { create: [
        { date: new Date('2026-09-10'), label: 'UAT Completion' },
        { date: new Date('2026-09-15'), label: 'Production Readiness Review' },
        { date: new Date('2026-09-20'), label: 'Production Deployment' },
      ] },
    },
  });

  console.log('Seeding a sample uploaded status report file...');
  try {
    const assetPath = path.join(__dirname, 'seed-assets', 'sample-weekly-report.html');
    if (fs.existsSync(assetPath)) {
      const uploadsDir = `${process.env.ATTACHMENTS_DIR ?? '/opt/doyensys/uploads'}/status-reports`;
      fs.mkdirSync(uploadsDir, { recursive: true });
      const storedPath = path.join(uploadsDir, `${abcCorp.id}-WEEKLY-2026-09-08-seed.html`);
      fs.copyFileSync(assetPath, storedPath);
      const stat = fs.statSync(storedPath);

      await prisma.statusReportUpload.upsert({
        where: { orgId_type_reportDate: { orgId: abcCorp.id, type: 'WEEKLY', reportDate: new Date('2026-09-08') } },
        update: {},
        create: {
          orgId: abcCorp.id, type: 'WEEKLY', reportDate: new Date('2026-09-08'),
          uploadedById: raviKumar.id, filename: 'MOREgroup_Weekly_Status_Report_09082026.html',
          storedPath, mimeType: 'text/html', sizeBytes: stat.size,
        },
      });
      console.log('Sample report file seeded for 2026-09-08 (weekly).');
    } else {
      console.log('No seed-assets/sample-weekly-report.html found — skipping sample file upload.');
    }
  } catch (err) {
    console.warn('Could not seed sample report file (non-fatal):', err);
  }

  console.log('\nSeed complete.');
  console.log(`All seeded users share the password: ${SEED_PASSWORD}`);
  console.log(`Customer login: ${johnSmith.email}`);
  console.log(`Support login:  ${raviKumar.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
