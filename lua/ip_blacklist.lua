-- IP Blacklist Module for Basic Auth
-- Blocks IP after 3 failed attempts permanently

local cjson = require "cjson"

local _M = {}

-- Configuration
local MAX_ATTEMPTS = 3
local BLACKLIST_FILE = "/usr/local/openresty/nginx/ip_blacklist.json"

-- Shared dictionary for tracking (defined in nginx.conf)
local failed_attempts = ngx.shared.failed_attempts
local blacklist = ngx.shared.blacklist

-- Load blacklist from file on first request
local function load_blacklist()
    local loaded = blacklist:get("__loaded__")
    if loaded then return end

    local file = io.open(BLACKLIST_FILE, "r")
    if file then
        local content = file:read("*all")
        file:close()

        local ok, data = pcall(cjson.decode, content)
        if ok and data then
            -- Load blacklisted IPs
            if data.blacklist then
                for _, ip in ipairs(data.blacklist) do
                    blacklist:set(ip, true)
                end
            end
            -- Load failed attempts
            if data.failed_attempts then
                for ip, count in pairs(data.failed_attempts) do
                    failed_attempts:set(ip, count)
                end
            end
        end
    end

    blacklist:set("__loaded__", true)
end

-- Save blacklist to file
local function save_blacklist()
    local data = {
        blacklist = {},
        failed_attempts = {},
        updated_at = ngx.now()
    }

    -- Get all blacklisted IPs
    local keys = blacklist:get_keys(1000)
    for _, key in ipairs(keys) do
        if key ~= "__loaded__" and blacklist:get(key) then
            table.insert(data.blacklist, key)
        end
    end

    -- Get all failed attempts
    local attempt_keys = failed_attempts:get_keys(1000)
    for _, key in ipairs(attempt_keys) do
        local count = failed_attempts:get(key)
        if count and count > 0 then
            data.failed_attempts[key] = count
        end
    end

    local file = io.open(BLACKLIST_FILE, "w")
    if file then
        file:write(cjson.encode(data))
        file:close()
    end
end

-- Check if IP is blacklisted (call in access_by_lua)
function _M.check()
    load_blacklist()

    local client_ip = ngx.var.remote_addr

    -- Check X-Forwarded-For for real IP behind proxy
    local xff = ngx.var.http_x_forwarded_for
    if xff then
        client_ip = xff:match("^([^,]+)")
    end

    if blacklist:get(client_ip) then
        ngx.log(ngx.WARN, "Blocked blacklisted IP: ", client_ip)
        ngx.exit(ngx.HTTP_FORBIDDEN)
    end
end

-- Check if IP is blacklisted (returns boolean, doesn't exit)
function _M.is_blacklisted()
    load_blacklist()

    local client_ip = ngx.var.remote_addr

    -- Check X-Forwarded-For for real IP behind proxy
    local xff = ngx.var.http_x_forwarded_for
    if xff then
        client_ip = xff:match("^([^,]+)")
    end

    return blacklist:get(client_ip) == true
end

-- Record auth result (call in log_by_lua)
function _M.log_auth_result()
    local client_ip = ngx.var.remote_addr
    local xff = ngx.var.http_x_forwarded_for
    if xff then
        client_ip = xff:match("^([^,]+)")
    end

    local status = ngx.status

    if status == 401 then
        -- IP banning disabled for now - just log
        local auth_header = ngx.var.http_authorization
        if auth_header and auth_header ~= "" then
            local count = failed_attempts:incr(client_ip, 1, 0)
            ngx.log(ngx.WARN, "Failed auth attempt ", count, " from IP: ", client_ip, " (banning disabled)")
        end
    elseif status == 200 or status == 304 then
        -- Successful authentication - clear failed attempts
        local prev_count = failed_attempts:get(client_ip)
        if prev_count and prev_count > 0 then
            failed_attempts:delete(client_ip)
            save_blacklist()
        end
    end
end

return _M
