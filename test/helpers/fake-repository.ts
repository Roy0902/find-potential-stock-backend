import type { ListCommentsQuery } from '../../src/types/request/comments.request.js';
import type { CommentListResponse, CommentSummary } from '../../src/types/response/comments.response.js';
import type { ForumListResponse } from '../../src/types/response/forums.response.js';
import type { CommentRepository } from '../../src/repository/commentRepository.js';
import { buildExcerpt } from '../../src/repository/commentRepository.js';

type FakeComment = {
  id: number;
  body: string;
  postedAt: string;
  url: string;
  threadId: number;
  threadTitle: string;
  sourceId: number;
  sourceName: string;
  displayName: string;
  externalId: string;
  parentId: number | null;
};

/** In-memory stand-in for the read-side queries, seeded with visible data only. */
export class FakeCommentRepository implements CommentRepository {
  constructor(
    private readonly comments: FakeComment[] = [],
    private readonly forums: Array<{ id: number; name: string }> = [],
  ) {}

  async listComments(query: ListCommentsQuery): Promise<CommentListResponse> {
    const filtered = this.comments
      .filter((comment) => query.forumId === undefined || comment.sourceId === query.forumId)
      .filter(
        (comment) => !query.search || comment.body.toLowerCase().includes(query.search.toLowerCase()),
      )
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));

    const start = (query.page - 1) * query.pageSize;
    return {
      comments: filtered.slice(start, start + query.pageSize).map((comment) => this.toSummary(comment)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / query.pageSize),
      },
    };
  }

  async listForums(): Promise<ForumListResponse> {
    const forums = this.forums
      .map((forum) => ({
        ...forum,
        commentCount: this.comments.filter((comment) => comment.sourceId === forum.id).length,
      }))
      // Forums with no visible comments are hidden (FR-19e).
      .filter((forum) => forum.commentCount > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    return { forums };
  }

  async getCommentById(id: number): Promise<CommentSummary | null> {
    const comment = this.comments.find((candidate) => candidate.id === id);
    return comment ? this.toSummary(comment) : null;
  }

  async findSourceUrlById(id: number): Promise<string | null> {
    return this.comments.find((candidate) => candidate.id === id)?.url ?? null;
  }

  private toSummary(comment: FakeComment): CommentSummary {
    return {
      id: comment.id,
      body: comment.body,
      postedAt: comment.postedAt,
      url: comment.url,
      threadId: comment.threadId,
      threadTitle: comment.threadTitle,
      sourceName: comment.sourceName,
      author: {
        displayName: comment.displayName,
        externalId: comment.externalId,
        isBlocked: false,
      },
      parentId: comment.parentId,
      replyTargetUnknown: false,
      excerpt: buildExcerpt(comment.body),
    };
  }
}

export function fakeComment(overrides: Partial<FakeComment> & { id: number }): FakeComment {
  return {
    body: 'AAPL 今日破頂',
    postedAt: '2026-10-01T00:10:00.000Z',
    url: 'https://lihkg.com/thread/1001/page/1#comment',
    threadId: 1001,
    threadTitle: '美股討論區',
    sourceId: 1,
    sourceName: 'LIHKG',
    displayName: '股壇新手',
    externalId: 'u2001',
    parentId: null,
    ...overrides,
  };
}
