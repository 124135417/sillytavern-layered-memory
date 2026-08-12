import { handleStateReviewJob } from './state-review.js';

/**
 * Compatibility handler for <=0.16.x persisted jobs.
 * Old state_gc jobs used to let the auxiliary model delete entries directly.
 * Route them through the review-first workflow instead.
 */
export async function handleStateGcJob() {
    return handleStateReviewJob();
}
