variable "project" {
  type    = string
  default = "doax"
}

variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "profile" {
  type    = string
  default = "doax"
}

variable "zone" {
  description = "Route53 hosted zone the hostname lives in."
  type        = string
  default     = "doax.io"
}

variable "domain" {
  description = "Public hostname of the registry API (the Fixed Interface, spec §10). npm model: registry.* is the API; the apex/www is the human website."
  type        = string
  default     = "registry.doax.io"
}

variable "operator" {
  type    = string
  default = "doax.io"
}

variable "lambda_memory" {
  type    = number
  default = 256
}

variable "lambda_timeout" {
  type    = number
  default = 30
}
