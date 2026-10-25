/** Every JSON response uses this envelope. */
export type ApiResponse<T> = {
  code: number;
  message: string;
  data: T;
};

export type ErrorResponse = ApiResponse<null>;

/** 404 body for a comment that exists but is not publicly visible. */
export type CommentUnavailableResponse = ApiResponse<{ sourceUrl: string | null }>;
