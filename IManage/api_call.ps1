# Default API Base URL and Token (can be overridden by function parameters)
$defaultBaseURL = "https://imanage.yeaft.com"
$defaultToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjbGllbnRfaWQiOiIxMTExMTExMSIsInRva2VuX3R5cGUiOiJhY2Nlc3MiLCJzY29wZSI6InJlYWQgd3JpdGUifQ.KDSWuSUTspkjqxJPK-Z-uSIGDlEGky6xJNn9CkIm6t8"  # Replace with a default token if you have one

function Invoke-IMAPI {
    param (
        [string]$methodName,           # The endpoint name, e.g., "authorize", "getCustomerInfo", etc.
        [string]$token = $defaultToken, # Access token for authentication, defaults to $defaultToken if not provided
        [string]$baseURL = $defaultBaseURL,  # API base URL, defaults to $defaultBaseURL if not provided
        [hashtable]$parameters = @{}    # Optional parameters specific to the endpoint
    )

    # Display help if the methodName is "--help"
    if ($methodName -eq "--help") {
        Show-Help
        return
    }

    # Mapping method names to endpoints and HTTP methods
    $apiMap = @{
        "authorize" = @{ method = "GET"; path = "/authorize" }
        "callback" = @{ method = "GET"; path = "/callback" }
        "token" = @{ method = "POST"; path = "/token" }
        "getCustomerInfo" = @{ method = "GET"; path = "/api" }
        "getGlobalDocuments" = @{ method = "GET"; path = "/work/api/v2/customers/{customerId}/documents" }
        "getDocumentsByLibrary" = @{ method = "GET"; path = "/work/api/v2/customers/{customerId}/libraries/{libraryId}/documents" }
        "downloadDocument" = @{ method = "GET"; path = "/work/api/v2/customers/{customerId}/libraries/{libraryId}/documents/{docId}/download" }
        "getDocumentACL" = @{ method = "GET"; path = "/work/api/v2/customers/{customerId}/libraries/{libraryId}/documents/{docId}/security" }
        "getLibraries" = @{ method = "GET"; path = "/work/api/v2/customers/{customerId}/libraries" }
        "getGroups" = @{ method = "GET"; path = "/work/api/v2/customers/{customerId}/libraries/{libraryId}/groups" }
        "getGroupMembers" = @{ method = "GET"; path = "/work/api/v2/customers/{customerId}/libraries/{libraryId}/groups/{groupId}/members" }
        "previewEmail" = @{ method = "GET"; path = "/work/api/v2/customers/{customerId}/libraries/{libraryId}/email/{docId}/preview" }
    }

    # Verify method name exists
    if (-not $apiMap.ContainsKey($methodName)) {
        Write-Output "Error: Unsupported method name '$methodName'. Use '--help' to see supported methods."
        return
    }

    # Extract API endpoint details
    $apiDetails = $apiMap[$methodName]
    $method = $apiDetails.method
    $path = $apiDetails.path

    # Replace path variables if available
    foreach ($key in $parameters.Keys) {
        $path = $path -replace "{${key}}", $parameters[$key]
    }

    # Build request URL
    $url = "$baseURL$path"

    # Log the request details
    Write-Output "Request URL: $url"
    Write-Output "HTTP Method: $method"
    Write-Output "Headers: @{ 'x-auth-token' = '$token'; 'Content-Type' = 'application/json' }"
    Write-Output "Parameters: $($parameters | Out-String)"

    # Prepare headers
    $headers = @{
        "x-auth-token" = $token  # Use x-auth-token as the header key
        "Content-Type"  = "application/json"
    }

    # Prepare body for POST requests
    $body = $null
    if ($method -eq "POST" -and $parameters) {
        $body = $parameters | ConvertTo-Json
        Write-Output "Request Body: $body"
    }

    # Invoke API request
    try {
        $response = Invoke-RestMethod -Uri $url -Method $method -Headers $headers -Body $body
        Write-Output "Response: $($response | ConvertTo-Json -Depth 5)"
    }
    catch {
        Write-Output "Error: $($_.Exception.Message)"
    }
}

function Show-Help {
    Write-Output "Usage: Invoke-IMAPI -methodName <endpoint> -token <token> -baseURL <url> -parameters <parameters>"
    Write-Output "Available Endpoints:"
    Write-Output "  - authorize"
    Write-Output "  - callback"
    Write-Output "  - token"
    Write-Output "  - getCustomerInfo"
    Write-Output "  - getGlobalDocuments"
    Write-Output "  - getDocumentsByLibrary"
    Write-Output "  - downloadDocument"
    Write-Output "  - getDocumentACL"
    Write-Output "  - getLibraries"
    Write-Output "  - getGroups"
    Write-Output "  - getGroupMembers"
    Write-Output "  - previewEmail"
    Write-Output ""
    Write-Output "Parameters:"
    Write-Output "  - methodName: The name of the API endpoint you want to call."
    Write-Output "  - token: The access token for authorization (default: $defaultToken)."
    Write-Output "  - baseURL: The base URL for the API (default: $defaultBaseURL)."
    Write-Output "  - parameters: A hashtable of parameters to include in the request, such as path variables or query parameters."
    Write-Output ""
    Write-Output "Examples:"
    Write-Output '  Invoke-IMAPI -methodName "authorize" -token "<YourToken>" -parameters @{ client_id = "<YourClientID>"; redirect_uri = "https://localhost/v1.0/admin/oauth/callback"; state = "example_state" }'
    Write-Output '  Invoke-IMAPI -methodName "getCustomerInfo" -token "<YourToken>"'
    Write-Output '  Invoke-IMAPI -methodName "getGlobalDocuments" -token "<YourToken>" -parameters @{ customerId = "12345"; offset = 0; limit = 10 }'
    Write-Output '  Invoke-IMAPI -methodName "token" -token "<YourToken>" -parameters @{ grant_type = "authorization_code"; client_id = "<YourClientID>"; client_secret = "<YourClientSecret>"; code = "<AuthCode>" }'
}

# Example: To display help
# Invoke-IMAPI --help
