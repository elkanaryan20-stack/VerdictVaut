# DESIGNED, NOT APPLIED. See infra/terraform/README.md.
#
# Implements docs/aws-network-design.md: 1 VPC, 2 AZs, 3 subnet tiers
# (public / private-app / private-db, isolated), an Internet Gateway,
# NAT gateway(s) per var.nat_gateway_per_az, and the 5 security groups
# from that document's §5. No security group here ever allows inbound
# from 0.0.0.0/0 except the ALB's own listener ports.

locals {
  name_prefix = "verdictvaut-${var.environment}"
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "${local.name_prefix}-vpc"
    Environment = var.environment
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name        = "${local.name_prefix}-igw"
    Environment = var.environment
  }
}

# --- Public subnets (ALB, NAT gateways) ---------------------------------

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = false # ALB gets its own public IP; nothing else in this subnet needs auto-assign

  tags = {
    Name        = "${local.name_prefix}-public-${count.index}"
    Environment = var.environment
    Tier        = "public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name        = "${local.name_prefix}-public-rt"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# --- NAT gateways --------------------------------------------------------
# var.nat_gateway_per_az = true  -> one per AZ (production)
# var.nat_gateway_per_az = false -> single shared gateway in AZ 0 (staging)

resource "aws_eip" "nat" {
  count  = var.nat_gateway_per_az ? 2 : 1
  domain = "vpc"

  tags = {
    Name        = "${local.name_prefix}-nat-eip-${count.index}"
    Environment = var.environment
  }
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_gateway_per_az ? 2 : 1
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name        = "${local.name_prefix}-nat-${count.index}"
    Environment = var.environment
  }

  depends_on = [aws_internet_gateway.this]
}

# --- Private application subnets (ECS: web, api, worker) -----------------

resource "aws_subnet" "app" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.app_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name        = "${local.name_prefix}-app-${count.index}"
    Environment = var.environment
    Tier        = "private-app"
  }
}

resource "aws_route_table" "app" {
  count  = 2
  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = var.nat_gateway_per_az ? aws_nat_gateway.this[count.index].id : aws_nat_gateway.this[0].id
  }

  tags = {
    Name        = "${local.name_prefix}-app-rt-${count.index}"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "app" {
  count          = 2
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

# --- Private database subnets (RDS) — isolated, no internet route --------

resource "aws_subnet" "db" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = var.db_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name        = "${local.name_prefix}-db-${count.index}"
    Environment = var.environment
    Tier        = "private-db-isolated"
  }
}

# Deliberately NO route to an Internet Gateway or NAT gateway — this
# route table only ever carries the VPC's own local route, added
# implicitly by AWS to every route table. RDS must not be publicly
# accessible (docs/aws-network-design.md §2) — this table's emptiness
# is a large part of how that's structurally enforced, independent of
# the RDS instance's own "publicly accessible" flag (see modules/database).
resource "aws_route_table" "db" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name        = "${local.name_prefix}-db-rt"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "db" {
  count          = 2
  subnet_id      = aws_subnet.db[count.index].id
  route_table_id = aws_route_table.db.id
}

# --- Security groups (docs/aws-network-design.md §5) ----------------------

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb-sg"
  description = "Public ALB — the only security group in this design with an inbound rule from 0.0.0.0/0."
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS from the internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP from the internet — redirect listener only, never forwards to a target"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "To the web/API task security groups only (target-group forwarding)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = {
    Name        = "${local.name_prefix}-alb-sg"
    Environment = var.environment
  }
}

resource "aws_security_group" "web_task" {
  name        = "${local.name_prefix}-web-task-sg"
  description = "verdictvaut-web ECS tasks — inbound from the ALB security group only."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "From the ALB only"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Outbound HTTPS (via NAT) to the API's public DNS and other HTTPS dependencies"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${local.name_prefix}-web-task-sg"
    Environment = var.environment
  }
}

resource "aws_security_group" "api_task" {
  name        = "${local.name_prefix}-api-task-sg"
  description = "verdictvaut-api ECS tasks (incl. the Fireblocks webhook route) — inbound from the ALB security group only."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "From the ALB only"
    from_port       = 4000
    to_port         = 4000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Outbound — RDS (below) plus HTTPS (via NAT) to Fireblocks/Elliptic/Postmark/Secrets Manager"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${local.name_prefix}-api-task-sg"
    Environment = var.environment
  }
}

resource "aws_security_group" "worker_task" {
  name        = "${local.name_prefix}-worker-task-sg"
  description = "verdictvaut-worker ECS tasks — NO inbound rule of any kind. The worker binds no HTTP port (worker.main.ts's own design)."
  vpc_id      = aws_vpc.this.id

  # Deliberately no ingress block at all.

  egress {
    description = "Outbound — RDS (below) plus HTTPS (via NAT) to blockchain RPC endpoints and Fireblocks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${local.name_prefix}-worker-task-sg"
    Environment = var.environment
  }
}

resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds-sg"
  description = "RDS for PostgreSQL — inbound 5432 from the API and worker task security groups only. Never a public CIDR."
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "From the API tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api_task.id]
  }

  ingress {
    description     = "From the worker tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.worker_task.id]
  }

  # Deliberately no egress rule beyond AWS's own default (all outbound
  # allowed) is needed — the DB subnet tier's own route table (above)
  # already has no route out of the VPC at all, so an egress rule here
  # would be unreachable in practice; left at the provider default
  # rather than adding a misleading rule that implies more control than
  # the route table already provides.

  tags = {
    Name        = "${local.name_prefix}-rds-sg"
    Environment = var.environment
  }
}
