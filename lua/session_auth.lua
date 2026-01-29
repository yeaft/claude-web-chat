-- Session-based authentication for Nginx Basic Auth
-- After successful Basic Auth, sets a session cookie to avoid repeated auth prompts

local _M = {}

-- Configuration
local SESSION_SECRET = "ai-writor-session-secret-key-2026"  -- Change this!
local SESSION_NAME = "ai_writor_session"
local SESSION_EXPIRY = 86400 * 7  -- 7 days in seconds
local HTPASSWD_FILE = "/etc/nginx/.htpasswd"

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

    -- Verify hash
    local expected = ngx.md5(ip .. "|" .. timestamp .. "|" .. SESSION_SECRET)
    return hash == expected
end

-- Check if request has valid session
function _M.check_session()
    local cookie = ngx.var["cookie_" .. SESSION_NAME]
    if cookie then
        local client_ip = ngx.var.remote_addr
        if verify_token(cookie, client_ip) then
            return true
        end
    end
    return false
end

-- Verify Basic Auth credentials against htpasswd file
function _M.verify_basic_auth()
    local auth = ngx.var.http_authorization
    if not auth then return false end

    local encoded = auth:match("^Basic%s+(.+)$")
    if not encoded then return false end

    local decoded = ngx.decode_base64(encoded)
    if not decoded then return false end

    local user, pass = decoded:match("^([^:]+):(.*)$")
    if not user or not pass then return false end

    -- Read htpasswd file
    local file = io.open(HTPASSWD_FILE, "r")
    if not file then
        ngx.log(ngx.ERR, "Cannot open htpasswd file: ", HTPASSWD_FILE)
        return false
    end

    for line in file:lines() do
        local stored_user, stored_hash = line:match("^([^:]+):(.+)$")
        if stored_user == user then
            file:close()

            -- Handle different htpasswd formats
            -- {SHA} format (htpasswd -s)
            if stored_hash:sub(1, 5) == "{SHA}" then
                local sha1 = ngx.sha1_bin(pass)
                local expected = ngx.encode_base64(sha1)
                return stored_hash:sub(6) == expected
            end

            -- apr1 MD5 format ($apr1$salt$hash) - most common
            if stored_hash:sub(1, 6) == "$apr1$" then
                -- Use os.execute to verify with htpasswd or openssl
                -- For simplicity, we'll use a different approach
                local apr1_verify = require("apr1_md5")
                if apr1_verify then
                    return apr1_verify.verify(pass, stored_hash)
                end
                -- Fallback: can't verify apr1, log warning
                ngx.log(ngx.WARN, "apr1 hash verification not supported, please use SHA format")
                return false
            end

            -- Plain text (not recommended but for testing)
            if stored_hash == pass then
                return true
            end

            return false
        end
    end
    file:close()
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
        -- Check if we need to set cookie (from authenticate())
        -- or if request already had valid session
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
            .. "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" .. SESSION_EXPIRY
        ngx.header["Set-Cookie"] = cookie_str
    end
end

return _M
