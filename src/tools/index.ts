// Tool system entry point: register all built-in tools and re-export

export type { ToolDefinition, ToolResult, ToolOptions, ToolCategory } from './types';
export { buildTool } from './build-tool';
export { registerTool, getTool, getAllTools, toFunctionDefinitions, toFunctionDefinitionsFiltered } from './registry';
export { checkPathPolicy, checkCommandPolicy } from './policy';
// RFC-005 Layer 2: file-state for staleness check
export { setFileState, getFileState, clearFileState, checkFileStaleness } from './file-state';
export type { FileState } from './file-state';

import { registerTool } from './registry';
import { bashTool } from './builtin/bash';
import { readTool } from './builtin/read';
import { writeTool } from './builtin/write';
import { globTool } from './builtin/glob';
import { grepTool } from './builtin/grep';
import { editTool } from './builtin/edit';
import { searchTool } from './builtin/search';
import { saveMemoryTool, initMemoryTool } from './builtin/save-memory';
import { webFetchTool } from './builtin/web-fetch';
import { webSearchTool } from './builtin/web-search';
import { skillManageTool } from './builtin/skill_manage';
import { skillsListTool } from './builtin/skills_list';
import { skillViewTool } from './builtin/skill_view';
import { skillOpenTool } from './builtin/skill_open';
import { skillFileReadTool } from './builtin/skill_file_read';
import { skillInfoTool } from './builtin/skill_info';
import { checkpointTool } from './builtin/checkpoint';
import { moaQueryTool } from './builtin/moa-query';
import { hrrRememberTool, initHrrTool } from './builtin/hrr-remember';
import { hrrRecallTool } from './builtin/hrr-recall';

export { initMemoryTool } from './builtin/save-memory';
export { initMoaTool } from './builtin/moa-query';
export { initHrrTool } from './builtin/hrr-remember';
export { getHrrMemory } from './builtin/hrr-remember';
export { autoSnapshotIfNeeded, resetCheckpointTurn, ShadowCheckpoint } from './builtin/checkpoint';

// Default-initialize the singleton HRR memory so the tools are usable even if
// the entry point forgets to call initHrrTool. Entry points may call initHrrTool
// again with a custom path/dim to override.
initHrrTool();

// Register all built-in tools
registerTool(bashTool);
registerTool(readTool);
registerTool(writeTool);
registerTool(globTool);
registerTool(grepTool);
registerTool(editTool);
registerTool(searchTool);
registerTool(saveMemoryTool);
registerTool(webFetchTool);
registerTool(webSearchTool);
registerTool(skillManageTool);
registerTool(skillsListTool);
registerTool(skillViewTool);
registerTool(skillOpenTool);
registerTool(skillFileReadTool);
registerTool(skillInfoTool);
registerTool(checkpointTool);
registerTool(moaQueryTool);
registerTool(hrrRememberTool);
registerTool(hrrRecallTool);
