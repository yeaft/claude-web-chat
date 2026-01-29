-- Session-based authentication for Nginx Basic Auth
-- After successful Basic Auth, sets a session cookie to avoid repeated auth prompts

local _M = {}

-- Configuration
local SESSION_SECRET = "ai-writor-session-secret-key-2026"  -- Change this!
local SESSION_NAME = "ai_writor_session"
local SESSION_EXPIRY = 86400 * 7  -- 7 days in seconds

-- Simple hash function for session token
local function generate_token(ip, user, timestamp)
    local data = ip .. "|" .. user .. "|" .. timestamp .. "|" .. SESSION_SECRET
    -- Use ngx.md5 for hashing
    return ngx.md5(data)
end

-- Verify session token
local function verify_token(token, ip)
    -- Token format: timestamp:hash
    local timestamp, hash = token:match("^(%d+):(%w+)$")
    if not timestamp or not hash then
        return false
    end

    -- Check expiry
    local now = ngx.time()
    local token_time = tonumber(timestamp)
    if now - token_time > SESSION_EXPIRY then
        return false
    end

    -- Verify hash (we don't know the user, so just verify with ip and timestamp)
    local expected = ngx.md5(ip .. "|" .. timestamp .. "|" .. SESSION_SECRET)
    return hash == expected
end

-- Check if request has valid session (call in access_by_lua)
-- Returns true if session is valid, false if Basic Auth needed
function _M.check_session()
    local cookie = ngx.var["cookie_" .. SESSION_NAME]
    if cookie then
        local client_ip = ngx.var.remote_addr
        if verify_token(cookie, client_ip) then
            -- Valid session, skip Basic Auth
            return true
        end
    end
    return false
end

-- Set session cookie after successful Basic Auth (call in header_filter_by_lua)
function _M.set_session_cookie()
    -- Only set cookie on successful auth (status 200, 304, etc., not 401)
    local status = ngx.status
    if status >= 200 and status < 400 then
        -- Check if already has valid session
        local cookie = ngx.var["cookie_" .. SESSION_NAME]
        local client_ip = ngx.var.remote_addr
        if cookie and verify_token(cookie, client_ip) then
            return  -- Already has valid session
        end

        -- Generate new session token
        local timestamp = ngx.time()
        local hash = ngx.md5(client_ip .. "|" .. timestamp .. "|" .. SESSION_SECRET)
        local token = timestamp .. ":" .. hash

        -- Set cookie
        local cookie_str = SESSION_NAME .. "=" .. token
            .. "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" .. SESSION_EXPIRY
        ngx.header["Set-Cookie"] = cookie_str
    end
end

return _M
