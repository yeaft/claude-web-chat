-- Session-based authentication for Nginx Basic Auth
-- After successful Basic Auth, sets a session cookie to avoid repeated auth prompts

local _M = {}

-- Configuration
local SESSION_SECRET = "ai-writor-session-secret-key-2026"  -- Change this!
local SESSION_NAME = "ai_writor_session"
local SESSION_EXPIRY = 86400 * 7  -- 7 days in seconds

-- Valid users (username -> password) - simpler than htpasswd parsing
local VALID_USERS = {
    ["hyi"] = "1qaz@WSX3edc"  -- Change this password!
}

-- Verify session token (NO IP binding - supports users behind proxies/load balancers)
local function verify_token(token)
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

    -- Verify hash (not bound to IP)
    local expected = ngx.md5(timestamp .. "|" .. SESSION_SECRET)
    return hash == expected
end

-- Check if request has valid session
function _M.check_session()
    local cookie = ngx.var["cookie_" .. SESSION_NAME]
    if cookie then
        if verify_token(cookie) then
            return true
        end
    end
    return false
end

-- Verify Basic Auth credentials against configured users
function _M.verify_basic_auth()
    local auth = ngx.var.http_authorization
    if not auth then return false end

    local encoded = auth:match("^Basic%s+(.+)$")
    if not encoded then return false end

    local decoded = ngx.decode_base64(encoded)
    if not decoded then return false end

    local user, pass = decoded:match("^([^:]+):(.*)$")
    if not user or not pass then return false end

    -- Check against configured users
    local valid_pass = VALID_USERS[user]
    if valid_pass and valid_pass == pass then
        return true
    end

    return false
end

-- Main authentication function - call in access_by_lua
function _M.authenticate()
    -- Check session cookie first
    if _M.check_session() then
        return true
    end

    -- Check Basic Auth header
    if _M.verify_basic_auth() then
        ngx.ctx.need_session_cookie = true  -- Flag for header_filter
        return true
    end

    -- No valid auth - return 401
    ngx.header["WWW-Authenticate"] = 'Basic realm="AI Writor"'
    ngx.exit(ngx.HTTP_UNAUTHORIZED)
end

-- Set session cookie after successful auth (call in header_filter_by_lua)
function _M.set_session_cookie()
    -- Only set cookie on successful requests
    local status = ngx.status
    if status >= 200 and status < 400 then
        -- Check if already has valid session
        local cookie = ngx.var["cookie_" .. SESSION_NAME]
        if cookie and verify_token(cookie) then
            return  -- Already has valid session
        end

        -- Generate new session token (not bound to IP)
        local timestamp = ngx.time()
        local hash = ngx.md5(timestamp .. "|" .. SESSION_SECRET)
        local token = timestamp .. ":" .. hash

        -- Set cookie
        local cookie_str = SESSION_NAME .. "=" .. token
            .. "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" .. SESSION_EXPIRY
        ngx.header["Set-Cookie"] = cookie_str
    end
end

return _M
