CREATE TABLE users(
    id BIGINT,
    platform TEXT,
    notify BOOLEAN DEFAULT true,
    format INT DEFAULT 0,
    group_name TEXT,
    query TEXT,
    PRIMARY KEY(id, platform)
);
