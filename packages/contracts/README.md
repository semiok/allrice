# Shared contracts

`@allrice/contracts` is the only allowed authority for types that cross Web, Worker, persistence, and streaming boundaries.

Version 0.1.0 defines only health contracts. Business contracts remain deliberately absent until [MET-49](https://linear.app/metasnowsky/issue/MET-49/v1-%E6%A0%B8%E5%BF%83%E5%A5%91%E7%BA%A6%E5%86%BB%E7%BB%93%E7%A7%9F%E6%88%B7%E6%8E%88%E6%9D%83queueruneventskillhub-%E4%B8%8E-storage) is reviewed.

MET-49 will add runtime-validated definitions for RequestContext, ExecutionContext, authorization, Queue, Run/Event, SkillHub, Storage, SSE replay, and API compatibility. Packages must import these definitions instead of recreating local variants.
