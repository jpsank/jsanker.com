import { Link, Outlet } from "react-router-dom";
import { Navbar, Nav, Container } from 'react-bootstrap';
import { LinkContainer } from 'react-router-bootstrap';
import { useAuth } from "../contexts/AuthContext";

const Layout = () => {
    const { currentUser } = useAuth();
    return (
        <Container fluid className="p-0 d-flex flex-column align-items-center just">
            <Navbar bg="light" expand="lg" className="my-4 px-sm-5 px-3" style={{width: "100%", maxWidth: "1000px"}}>
                <LinkContainer to="/">
                    <Navbar.Brand className="fs-4 me-5">
                        jsanker.com
                    </Navbar.Brand>
                </LinkContainer>
                <Navbar.Toggle aria-controls="basic-navbar-nav" />
                <Navbar.Collapse id="basic-navbar-nav">
                    <Nav className="fs-5 flex-grow-1 justify-content-evenly" activeKey={window.location.pathname}>
                        <LinkContainer to="/projects">
                            <Nav.Link>Projects</Nav.Link>
                        </LinkContainer>
                        <LinkContainer to="/blogs">
                            <Nav.Link>Blogs</Nav.Link>
                        </LinkContainer>
                        {currentUser ? (
                            <LinkContainer to="/profile">
                                <Nav.Link>Profile</Nav.Link>
                            </LinkContainer>
                        ) : (
                            <LinkContainer to="/login">
                                <Nav.Link>Sign in</Nav.Link>
                            </LinkContainer>
                        )}
                    </Nav>
                </Navbar.Collapse>
            </Navbar>
            
            <Container fluid className="p-0" style={{minHeight: "64vh"}}>
                <Outlet />
            </Container>

            <Container fluid className="bg-dark text-white py-5 text-center">
                <div className="mx-auto d-flex flex-row gap-2 justify-content-around align-items-center" style={{maxWidth: "1000px"}}>
                    <Link to="/" className="text-white text-decoration-none">Home</Link>
                    <Link to="/projects" className="text-white text-decoration-none">Projects</Link>
                    <Link to="/blogs" className="text-white text-decoration-none">Blogs</Link>
                    © 2023 Julian Sanker
                </div>
            </Container>
        </Container>
    );
};

export default Layout;
