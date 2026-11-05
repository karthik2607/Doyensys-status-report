import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';

const LOG_PATH = process.env.PROJECT_ACTIVITY_LOG_PATH || '/opt/doyensys/logs/project-activity.log';

interface ProjectLogEntry {
  action: 'created' | 'updated';
  projectId: string;
  projectName: string;
  orgId: string;
  actorId: string;
  actorName: string;
  taskCount: number;
  phaseCount: number;
}

/** Appends a JSON-line to the project activity log file, and mirrors the
 * same event into the audit_log table so it's queryable from the app too —
 * the file is for easy tailing/grepping on the server, the DB row is for
 * anyone browsing history in-app later. */
export async function logProjectActivity(tx: Prisma.TransactionClient, entry: ProjectLogEntry) {
  try {
    const dir = path.dirname(LOG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(LOG_PATH, line);
  } catch (err) {
    console.error('[project-activity-log] Failed to write log file (non-fatal):', err);
  }

  try {
    await tx.auditLog.create({
      data: {
        actorId: entry.actorId, orgId: entry.orgId, action: `project_${entry.action}`,
        entityType: 'project', entityId: entry.projectId,
        metadata: { projectName: entry.projectName, taskCount: entry.taskCount, phaseCount: entry.phaseCount },
      },
    });
  } catch (err) {
    console.error('[project-activity-log] Failed to write audit_log row (non-fatal):', err);
  }
}
