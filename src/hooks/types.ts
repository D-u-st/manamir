// Hook system types (P-23)

export type HookEvent =
  | 'session:create' | 'session:destroy' | 'session:rotate' | 'session:adopt'
  | 'message:receive' | 'message:send'
  | 'executor:start' | 'executor:complete' | 'executor:error'
  | 'tool:before' | 'tool:after' | 'tool:error'
  | 'task:add' | 'task:start' | 'task:complete'
  | 'autonomous:task_complete' | 'autonomous:task_error'
  | 'memory:save'
  | 'background_review_unhealthy'
  | 'selfReview_unhealthy'
  | 'skillSynth_unhealthy'
  | 'error_monitor_alert'
  | 'shutdown';

export type HookHandler = (event: HookEvent, data: Record<string, unknown>) => void | Promise<void>;
