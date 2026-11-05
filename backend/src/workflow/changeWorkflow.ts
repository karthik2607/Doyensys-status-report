// Single explicit transition table — no API endpoint sets `stage` directly.
// Every stage change must go through applyTransition() below, which is the
// only place stage values are ever written.

export type ChangeStage =
  | 'RAISED' | 'CUSTOMER_APPROVAL' | 'DEV' | 'DEV_REVIEW'
  | 'TEST' | 'TEST_REVIEW' | 'PROD' | 'RESOLVED' | 'CLOSED';

type ActorClass = 'CUSTOMER' | 'SUPPORT';

interface TransitionDef {
  actor: ActorClass;
  to: ChangeStage;
  label: string;
  // Which ChangeDetail field this transition's `note` should be written to,
  // in addition to the change_history row (mirrors the prototype's
  // dev/test/prod evidence fields).
  evidenceField?: 'devNotes' | 'testNotes' | 'prodNotes';
}

export const CHANGE_TRANSITIONS: Record<ChangeStage, Record<string, TransitionDef>> = {
  RAISED: {}, // moves to CUSTOMER_APPROVAL automatically at creation, not via action
  CUSTOMER_APPROVAL: {
    approve: { actor: 'CUSTOMER', to: 'DEV', label: 'Approved' },
    request_info: { actor: 'CUSTOMER', to: 'CUSTOMER_APPROVAL', label: 'More information requested' },
    reject: { actor: 'CUSTOMER', to: 'CUSTOMER_APPROVAL', label: 'Rejected' },
  },
  DEV: {
    mark_dev_complete: { actor: 'SUPPORT', to: 'DEV_REVIEW', label: 'Development marked complete', evidenceField: 'devNotes' },
  },
  DEV_REVIEW: {
    approve_for_testing: { actor: 'CUSTOMER', to: 'TEST', label: 'Approved for testing' },
    request_changes: { actor: 'CUSTOMER', to: 'DEV', label: 'Changes requested' },
  },
  TEST: {
    submit_test_results: { actor: 'SUPPORT', to: 'TEST_REVIEW', label: 'Test results submitted', evidenceField: 'testNotes' },
  },
  TEST_REVIEW: {
    approve_for_production: { actor: 'CUSTOMER', to: 'PROD', label: 'Approved for production' },
    request_retest: { actor: 'CUSTOMER', to: 'TEST', label: 'Retest requested' },
    reject: { actor: 'CUSTOMER', to: 'DEV', label: 'Rejected — back to development' },
  },
  PROD: {
    record_deployment_complete: { actor: 'SUPPORT', to: 'RESOLVED', label: 'Deployment recorded complete', evidenceField: 'prodNotes' },
  },
  RESOLVED: {
    close_change: { actor: 'SUPPORT', to: 'CLOSED', label: 'Change closed' },
  },
  CLOSED: {},
};

export function isActorAllowed(actorClass: ActorClass, role: string): boolean {
  const isSupport = role === 'SUPPORT_AGENT' || role === 'SUPPORT_MANAGER';
  return actorClass === 'SUPPORT' ? isSupport : !isSupport;
}
