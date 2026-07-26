/** マイクロコミットとメイン HEAD の紐づけ（Main-Head trailer） */

export const MAIN_HEAD_TRAILER = 'Main-Head';

export interface MainCommitInfo {
    hash: string;
    subject: string;
}

export interface MainIntervalOption {
    /** 'all' | 'unclassified' | フルハッシュ */
    id: string;
    label: string;
    /** null=すべて、''=未分類、それ以外=その Main-Head に一致 */
    mainHead: string | null;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

export function formatMainHeadTrailer(sha: string): string {
    return `${MAIN_HEAD_TRAILER}: ${sha}`;
}

/** subject / body から Main-Head trailer を取り出す */
export function parseMainHeadFromMessage(subject: string, body = ''): string | undefined {
    const text = `${subject}\n${body}`;
    const m = text.match(new RegExp(`^${MAIN_HEAD_TRAILER}:\\s*([0-9a-f]{7,40})\\s*$`, 'im'));
    if (!m?.[1]) {
        return undefined;
    }
    return m[1].toLowerCase();
}

export function buildMicroCommitMessage(
    relativeFilePath: string,
    fromAi: boolean,
    mainHead?: string,
): string {
    const timestamp = new Date().toISOString();
    const subject = fromAi
        ? `micro: [AI] saved ${relativeFilePath} at ${timestamp}`
        : `micro: saved ${relativeFilePath} at ${timestamp}`;
    if (mainHead && FULL_SHA.test(mainHead)) {
        return `${subject}\n\n${formatMainHeadTrailer(mainHead)}`;
    }
    return subject;
}

export function shortHash(hash: string | undefined, len = 7): string {
    if (!hash) {
        return '-';
    }
    return hash.substring(0, len);
}

function truncateSubject(subject: string, max = 40): string {
    const s = subject.replace(/\s+/g, ' ').trim();
    if (s.length <= max) {
        return s;
    }
    return `${s.slice(0, max - 1)}…`;
}

/**
 * メイン log（新しい順）から UI 用の区間オプションを作る。
 * Main-Head = A のマイクロは「A の上での作業」＝ A → 次のメインコミット（またはいまの作業）。
 */
export function buildMainIntervalOptions(
    mainCommitsNewestFirst: MainCommitInfo[],
    microMainHeads: Array<string | undefined>,
): MainIntervalOption[] {
    const options: MainIntervalOption[] = [
        { id: 'all', label: 'すべて（ブランチ全体）', mainHead: null },
    ];

    const seenMicro = new Set(
        microMainHeads
            .filter((h): h is string => typeof h === 'string' && h.length > 0)
            .map((h) => h.toLowerCase()),
    );
    const hasUnclassified = microMainHeads.some((h) => !h);

    for (let i = 0; i < mainCommitsNewestFirst.length; i++) {
        const base = mainCommitsNewestFirst[i];
        const baseLower = base.hash.toLowerCase();
        const newer = i === 0 ? undefined : mainCommitsNewestFirst[i - 1];
        const range = newer
            ? `${shortHash(base.hash)} → ${shortHash(newer.hash)}`
            : `${shortHash(base.hash)} → いまの作業`;
        const label = `${range}  ${truncateSubject(base.subject || '(no subject)')}`;
        // 現在 HEAD・ログ上の隣接・実際にマイクロが紐づくものだけ出す
        if (i === 0 || i === 1 || seenMicro.has(baseLower) || (newer && seenMicro.has(newer.hash.toLowerCase()))) {
            options.push({
                id: baseLower,
                label,
                mainHead: baseLower,
            });
        }
    }

    // メイン log に無い Main-Head（rebase 後など）
    const listed = new Set(options.map((o) => o.id));
    for (const h of seenMicro) {
        if (!listed.has(h)) {
            options.push({
                id: h,
                label: `${shortHash(h)} → ?（ログ外）`,
                mainHead: h,
            });
        }
    }

    if (hasUnclassified) {
        options.push({
            id: 'unclassified',
            label: '未分類（Main-Head なし）',
            mainHead: '',
        });
    }

    return options;
}

export function filterCommitsByMainInterval<T extends { mainHead?: string }>(
    commits: T[],
    intervalMainHead: string | null,
): T[] {
    if (intervalMainHead === null) {
        return commits;
    }
    if (intervalMainHead === '') {
        return commits.filter((c) => !c.mainHead);
    }
    const want = intervalMainHead.toLowerCase();
    return commits.filter((c) => (c.mainHead || '').toLowerCase() === want);
}
