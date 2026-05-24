// Tests for src/skills/recommender.ts: scoring, threshold, top-K, recency,
// tag boost, format output.

import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  recommendSkillsForTask,
  formatSkillRecommendations,
} from '../src/skills/recommender';
import type { SkillSummary } from '../src/skills/types';

function skill(
  name: string,
  description: string,
  opts: Partial<SkillSummary> = {}
): SkillSummary {
  return {
    name,
    description,
    path: opts.path ?? `skills/${name}`,
    category: opts.category,
    tags: opts.tags,
    last_used_at: opts.last_used_at,
    use_count: opts.use_count,
    version: opts.version,
    source: opts.source,
  };
}

describe('recommendSkillsForTask — empty inputs', () => {
  test('empty skill list returns empty recs', () => {
    const recs = recommendSkillsForTask('do something with the database', []);
    assert.deepStrictEqual(recs, []);
  });

  test('empty prompt returns empty recs', () => {
    const skills = [skill('database-tool', 'Database management')];
    const recs = recommendSkillsForTask('', skills);
    assert.deepStrictEqual(recs, []);
  });

  test('whitespace-only prompt returns empty', () => {
    const skills = [skill('database-tool', 'Database management')];
    const recs = recommendSkillsForTask('   \n\t  ', skills);
    assert.deepStrictEqual(recs, []);
  });
});

describe('recommendSkillsForTask — basic matching', () => {
  test('matches skill on description token', () => {
    const skills = [
      skill('check-logs', 'Check today bot logs for errors', {
        category: 'ops',
      }),
    ];
    const recs = recommendSkillsForTask(
      'please check the bot logs for any errors today',
      skills,
      { threshold: 0.1 }
    );
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].skillName, 'check-logs');
    assert.ok(recs[0].score > 0);
  });

  test('matches on skill name when prompt mentions it', () => {
    const skills = [
      skill('restart-bot', 'Restart the bot in tmux'),
    ];
    const recs = recommendSkillsForTask('restart the bot now', skills);
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].skillName, 'restart-bot');
  });
});

describe('recommendSkillsForTask — top K', () => {
  test('caps recs at K', () => {
    const skills = [
      skill('db-a', 'database query helper'),
      skill('db-b', 'database migration helper'),
      skill('db-c', 'database backup helper'),
      skill('db-d', 'database cache helper'),
      skill('db-e', 'database index helper'),
    ];
    const recs = recommendSkillsForTask(
      'database helper for working with database',
      skills,
      { topK: 3, threshold: 0.1 }
    );
    assert.strictEqual(recs.length, 3);
  });
});

describe('recommendSkillsForTask — threshold filtering', () => {
  test('skills below threshold are excluded', () => {
    const skills = [
      // High score: name + description both contain "database"
      skill('database-pro', 'database query and migration tools', {
        tags: ['database'],
      }),
      // Low score: only one weak overlap on a generic word
      skill('config-helper', 'Adjust runtime helper for log settings'),
    ];
    const recs = recommendSkillsForTask(
      'work with database tooling',
      skills,
      { threshold: 0.7 }
    );
    // Only database-pro should make it past 0.7.
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].skillName, 'database-pro');
  });

  test('higher threshold can yield zero recs', () => {
    const skills = [skill('check-logs', 'Check today bot logs for errors')];
    const recs = recommendSkillsForTask('check the logs', skills, {
      threshold: 5.0,
    });
    assert.deepStrictEqual(recs, []);
  });
});

describe('recommendSkillsForTask — recency boost', () => {
  test('recently-used skill ranks above stale skill with same keyword score', () => {
    const now = Date.now();
    const recentISO = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    const staleISO = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60d
    const skills = [
      skill('helper-stale', 'database tool for queries', {
        last_used_at: staleISO,
      }),
      skill('helper-recent', 'database tool for queries', {
        last_used_at: recentISO,
      }),
    ];
    const recs = recommendSkillsForTask('database tool for queries', skills, {
      now,
      topK: 2,
      threshold: 0.1,
    });
    assert.strictEqual(recs.length, 2);
    assert.strictEqual(recs[0].skillName, 'helper-recent');
    assert.strictEqual(recs[1].skillName, 'helper-stale');
    assert.ok(recs[0].score > recs[1].score);
  });
});

describe('recommendSkillsForTask — tag matching', () => {
  test('tag exact match outweighs description-only match', () => {
    const skills = [
      // Has the tag "deploy" exactly
      skill('deploy-helper', 'Helps with releases', {
        tags: ['deploy', 'release'],
      }),
      // Mentions deploy only in description (text hit, weight 1.0 vs tag 1.5)
      skill('deploy-doc', 'Documentation about deploy and release procedures', {
        tags: ['docs'],
      }),
    ];
    const recs = recommendSkillsForTask('deploy the latest release', skills, {
      topK: 2,
      threshold: 0.1,
    });
    assert.strictEqual(recs.length, 2);
    // Tag-matched skill should rank first.
    assert.strictEqual(recs[0].skillName, 'deploy-helper');
  });
});

describe('formatSkillRecommendations — output formatting', () => {
  test('empty recs → empty string', () => {
    assert.strictEqual(formatSkillRecommendations([], []), '');
  });

  test('renders open/close tags and skill_view per rec', () => {
    const skills = [
      skill('restart-bot', 'Restart manamir bot in tmux'),
      skill('check-logs', 'Check today bot logs for errors'),
    ];
    const recs = [
      { skillName: 'restart-bot', score: 0.9, reason: 'matched: restart' },
      { skillName: 'check-logs', score: 0.7, reason: 'matched: logs' },
    ];
    const out = formatSkillRecommendations(recs, skills);
    assert.match(out, /<skill-suggestions count="2">/);
    assert.match(out, /skill_view name="restart-bot": Restart manamir bot in tmux/);
    assert.match(out, /skill_view name="check-logs": Check today bot logs for errors/);
    assert.match(out, /<\/skill-suggestions>/);
  });
});

describe('recommendSkillsForTask — CJK tokenization (M-3)', () => {
  test('Chinese-only prompt matches a skill with Chinese tag', () => {
    const skills = [
      skill('login-bot', 'Bot 登录助手', {
        tags: ['登录', 'auth'],
      }),
    ];
    // Old [a-z0-9]+ tokenizer would have produced ZERO tokens from a pure-CN
    // prompt and returned no recs. The new \p{L}\p{N} tokenizer keeps "登录".
    const recs = recommendSkillsForTask('请帮我登录一下', skills, {
      threshold: 0.1,
    });
    assert.strictEqual(recs.length, 1, 'CN prompt should match CN tag');
    assert.strictEqual(recs[0].skillName, 'login-bot');
  });

  test('mixed CN+EN prompt still matches English skill', () => {
    const skills = [
      skill('database-pro', 'database query helper'),
    ];
    const recs = recommendSkillsForTask(
      '帮我看看 database 的连接情况',
      skills,
      { threshold: 0.1 }
    );
    assert.strictEqual(recs.length, 1);
    assert.strictEqual(recs[0].skillName, 'database-pro');
  });
});

describe('recommendSkillsForTask — env override', () => {
  test('REC_TOP_K env overrides default top K', () => {
    const skills = [
      skill('db-a', 'database alpha'),
      skill('db-b', 'database beta'),
      skill('db-c', 'database gamma'),
      skill('db-d', 'database delta'),
    ];
    process.env.REC_TOP_K = '2';
    try {
      const recs = recommendSkillsForTask('database lookup', skills, {
        threshold: 0.1,
      });
      assert.strictEqual(recs.length, 2);
    } finally {
      delete process.env.REC_TOP_K;
    }
  });

  test('REC_THRESHOLD env overrides default threshold', () => {
    const skills = [skill('weak-match', 'mentions database once')];
    process.env.REC_THRESHOLD = '5.0';
    try {
      const recs = recommendSkillsForTask('database', skills);
      assert.strictEqual(recs.length, 0);
    } finally {
      delete process.env.REC_THRESHOLD;
    }
  });
});
