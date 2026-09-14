# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Account-level resources shared by staging and production by design —
# today, only the container registry (module.ecr — see its own header
# note for why it is deliberately not duplicated per environment).
# Nothing else belongs here without the same "does this legitimately
# need to be identical across environments" justification; the default
# for any new resource remains a per-environment module, not this one.

module "ecr" {
  source = "../../modules/ecr"

  repository_names = ["web", "api", "worker"]
}
